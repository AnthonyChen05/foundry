# @foundry/desktop — Windows/desktop shell (Tauri)

P4 #3 per `docs/build-order.md`: a native shell that **reuses the web app UI**.

The shell owns two decisions — which core origin to load, and whether the
**local sandbox** (ADR-015, "dynamic container support") is enabled. First run
shows a picker (`ui/firstrun.html`, bundled, the only page that can call shell
commands); the stored URL then loads the core-served SPA at its own origin,
exactly like any browser — no CORS surface, no Tauri APIs exposed to it.

## Local sandbox (dynamic container support)

Enable it in the first-run page ("Run sandboxes locally"): that stores the
owner username + password in the shell config and spawns+supervises
**`@foundry/runner`** (`apps/runner`) — the local sandbox executor. Chats sent
with the **Local** location run their agent tool calls in an Open Terminal
container on THIS machine's Docker engine; "Push to cloud" later migrates the
chat's files + dependencies into a backend env.

Requirements: Node ≥ 22 on PATH, Docker Desktop running (with the OT image
pulled). The shell resolves the runner entry automatically next to the exe
(dev layout) or via the advanced "runner command" config. The runner's
password is stored in `foundry.json` (plaintext) and only ever handed to the
runner process; the local container runs with no LLM keys, so its egress is
plain internet (Docker Desktop VMs lack ipset). `--reconfigure` reopens the
picker; the runner log is `<app-config-dir>/runner.log`.

## Build

```sh
pnpm install                        # once (workspace incl. @tauri-apps/cli)
pnpm --filter @foundry/desktop bundle  # → src-tauri/target/release/foundry-desktop.exe
pnpm --filter @foundry/desktop check   # fast cargo type check
```

Note: the script is `bundle`, deliberately NOT `build` — recursive workspace
builds (`pnpm build` / test/smoke prebuilds) must skip the ~30-minute Rust
release compile; build the shell explicitly when you want it.

Icons: `pnpm --filter @foundry/desktop tauri icon app-icon.png` (source drawn
to match the web app's brand — dark tile, terracotta 4-point star).

## Server URL

Stored in `<app-config-dir>\foundry.json` (`%APPDATA%\app.foundry.desktop\foundry.json`
on Windows). Default prefill is `http://127.0.0.1:8787`.