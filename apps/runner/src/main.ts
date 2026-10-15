import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Dockerode from "dockerode";
import { FoundryClient, type FoundryError } from "@foundry/sdk-ts";
import { makeOtDriver } from "@foundry/core/sandbox";
import { ExecServer } from "./execserver.js";
import { sweepRunnerContainers } from "./sweep.js";
import { login } from "./client.js";

/**
 * foundry-runner (ADR-015): the desktop's local executor.
 *
 *   node main.js --server <url> --user <name> --password <pw>
 *                [--workspace-root <dir>] [--image <img>] [--name desktop]
 *
 * Becomes the core's "local" sandbox: logs in (username + password), connects
 * as clientKind "executor", registers (exec.register — reports Docker
 * liveness), and answers core's server→client executor requests on the LOCAL
 * Open Terminal container (core's own driver, pointed at this machine's
 * Docker engine). The workspace root persists across restarts so a dead env
 * re-materializes with its files; orphaned labeled containers are swept at
 * boot. The desktop shell supervises this process; running it by hand works
 * for dev.
 */

const RUNNER_VERSION = "0.1.0";
const RETRY_MS = 5_000;

interface Args {
  server: string;
  user: string;
  password: string;
  name: string;
  workspaceRoot: string;
  image: string;
}

function parseArgs(argv: string[]): Args | undefined {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const server = get("--server");
  const user = get("--user");
  const password = get("--password");
  if (server === undefined || user === undefined || password === undefined) return undefined;
  return {
    server: server.replace(/\/+$/, ""),
    user,
    password,
    name: get("--name") ?? "desktop",
    workspaceRoot: (get("--workspace-root") ?? join(homedir(), ".foundry", "workspaces")).replace(/\\/g, "/"),
    image: get("--image") ?? "ghcr.io/open-webui/open-terminal:slim",
  };
}

function log(msg: string): void {
  process.stdout.write(`foundry-runner: ${msg}\n`);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One executor lifecycle: connect, register, serve until the socket gives up.
 * Returns "stop" (asked to stop) or "auth" (session rejected — re-login).
 */
async function runOnce(args: Args, stop: { requested: boolean }): Promise<"stop" | "auth"> {
  const driver = await makeOtDriver(args.image);
  const swept = await sweepRunnerContainers(new Dockerode(), log).catch(() => -1);
  if (swept >= 0) log(`boot sweep: ${swept} orphan container(s) reclaimed`);

  const token = (await login(args.server, args.user, args.password)).token;
  log("logged in");

  const client = new FoundryClient({ baseUrl: args.server, token });
  const sock = client.socket({
    clientKind: "executor",
    clientVersion: `runner/${RUNNER_VERSION}`,
    autoReconnect: true,
  });

  const execServer = new ExecServer({
    driver,
    workspaceRoot: args.workspaceRoot,
    transport: { send: (method, params) => { void sock.req(method, params).catch(() => undefined); } },
    log,
  });
  sock.onServerRequest = (req) => execServer.handle(req.id, req.method, req.params);

  let settled: "stop" | "auth" | undefined;
  sock.onStatus = (status, error) => {
    if (status === "open") {
      void driver
        .daemonReachable()
        .then((dockerAvailable) =>
          sock.execRegister({
            name: args.name,
            version: RUNNER_VERSION,
            dockerAvailable,
            workspaceRoot: args.workspaceRoot,
          }))
        .then(() => log("registered with core"))
        .catch((err: unknown) => log(`register failed: ${errText(err)}`));
    }
    if (status === "closed") {
      // The socket stopped for good: auth failure (session expired) or a
      // deliberate close. Ordinary drops reconnect inside the socket.
      settled = (error as FoundryError | undefined)?.code === "authentication_error" ? "auth" : (stop.requested ? "stop" : "auth");
      if (settled === "stop") stop.requested = true;
    }
  };
  if (stop.requested) return "stop";

  await sock.connect();
  log(`connected executor → ${args.server} (workspace ${args.workspaceRoot})`);

  while (settled === undefined && !stop.requested) {
    await delay(1000);
  }
  try { sock.close(); } catch { /* already */ }
  return settled ?? "stop";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args === undefined) {
    process.stderr.write(
      "usage: node main.js --server <url> --user <name> --password <pw> [--workspace-root <dir>] [--image <img>] [--name <name>]\n",
    );
    process.exit(2);
  }
  const stop = { requested: false };
  process.on("SIGINT", () => { stop.requested = true; });
  process.on("SIGTERM", () => { stop.requested = true; });

  log(`starting (server ${args.server}, image ${args.image})`);
  let authStrikes = 0;
  while (!stop.requested) {
    try {
      const outcome = await runOnce(args, stop);
      authStrikes = 0;
      if (outcome === "stop") break;
      log("session rejected — re-login in 5s");
      await delay(RETRY_MS);
    } catch (err) {
      const msg = errText(err);
      if (msg.includes("401") || msg.toLowerCase().includes("authentication")) {
        authStrikes += 1;
        if (authStrikes >= 3) {
          log(`bad credentials (${msg}) — staying down; fix with --user/--password`);
          break;
        }
      }
      log(`runner error: ${msg} — retrying in ${RETRY_MS / 1000}s`);
      await delay(RETRY_MS);
    }
  }
  log("stopped");
  process.exit(0);
}

void main();