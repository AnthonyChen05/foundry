# @foundry/runner — the desktop's local executor (ADR-015)

The runner process behind the desktop app's **local sandbox** ("dynamic
container support"): a clientKind `executor` WS client that answers core's
server→client executor requests by executing them on an Open Terminal
container running on THIS machine's Docker engine — the same image, same caps,
same driver code core uses (`@foundry/core/sandbox`).

## Run (dev)

```sh
pnpm --filter @foundry/runner start -- \
  --server http://127.0.0.1:8787 --user admin --password <pw>
```

Flags: `--server` · `--user` · `--password` · `--name <executor name, default desktop>` ·
`--workspace-root <dir, default ~/.foundry/workspaces>` · `--image <OT image>`.

The desktop shell supervises this process (spawn + backoff restart + kill on
exit); run it by hand for development.

## Semantics

- **Per-chat local envs**: dirs `<workspaceRoot>/<chatId>`; the dir persists
  across runner restarts — core re-materializes a dead env over the same dir,
  so files survive everything except an explicit destroy.
- **Orphan sweep at boot**: containers labeled `foundry.runner=1` (this
  runner's own) are stopped+removed; core-hosted sandboxes (label
  `foundry.sandbox=1` only) are never touched.
- **PTY**: output pumps as `exec.pty.data` (no retransmit); exit is sent once;
  a core that answers "unknown pty" after a reconnect simply stops the pump.
- **Workspace tar** (push-to-cloud + backups): production tar path runs
  INSIDE the container (`tar czf`, excluding node_modules/.venv/__pycache__ —
  dependencies are reinstalled by the reconcile run, never copied), 512 MB
  cap, `exec.tar.chunk` slices pulled core-side.
- **Egress**: the local container has no egress proxy and no LLM keys — it
  runs ordinary shell with plain internet access on the owner's own machine
  (Docker Desktop VMs lack ipset; the allowlist firewall cannot boot there).

## Requirements

Node ≥ 22 and Docker Desktop running, with the Open Terminal image pulled
(`docker pull ghcr.io/open-webui/open-terminal:slim`).