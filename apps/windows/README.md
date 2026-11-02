# @foundry/windows — native Windows client (WinUI 3)

P6 per `docs/build-order.md` (replaces the P4 #3 Tauri shell — ADR-019): a NATIVE Windows
11 client. Its UI compiles into the exe; it connects to the Foundry core at any reachable
address (backend required for data, never for UI). Runs unpackaged, self-contained.

## Stack
- WinUI 3 / Windows App SDK 2.6.4, C#, .NET 10 (`net10.0-windows10.0.26100.0`)
- Build with the dotnet CLI only — no Visual Studio. `winapp` CLI (winget `Microsoft.WinAppCli`)
  for the dev loop + UI automation; `dotnet publish` for the artifact.

## Layout
```
FoundryWindows.slnx
├── Foundry.App/       WinUI 3 app: Router, SetupPage, LoginPage, MainShellPage (NavigationView),
│                      ChatsPage (list | messages | run-inspector), TermPage, FilesPage, SettingsPage
├── Foundry.Protocol/  wire shapes + WS frame parser + System.Text.Json source-gen context
├── Foundry.Sdk/       FoundrySocket (WS: handshake/cursors/resume/backoff/idem) + FoundryRest + seams
├── Foundry.Store/     AppStore state machine (the Android AppStore.kt port): server-authoritative
├── Foundry.RunnerSup/ spawns+supervises @foundry/runner (the local sandbox executor; ADR-015)
└── tests/Foundry.Tests/ xunit: unit battery + live-core integration (env-gated)
```

## Build / test / run
```sh
dotnet build FoundryWindows.slnx                                   # green battery: 0 warnings
dotnet test tests/Foundry.Tests                                    # unit (25)
FOUNDRY_TESTS_CORE_URL=http://127.0.0.1:17877 \
FOUNDRY_TESTS_PASSWORD=... dotnet test tests/Foundry.Tests        # + integration vs a live core
pnpm -C apps/core dev                                              # a core (FAKE sandbox driver = fine)
winapp run . --detach                                             # build + (optionally register +) launch
FOUNDRY_APP_DATA_DIR=<scratch> ... winapp run .                   # isolate config for UI tests
winapp ui screenshot -a Foundry.App                                # the UIA evidence battery
dotnet publish -c Release -r win-x64                               # → bin/.../win-x64/publish (zip = the artifact)
```

Env hooks for the UI battery (real users never see these): `FOUNDRY_TESTS_CORE_URL`
(prefills the setup/login + auto-signs-in), `FOUNDRY_TESTS_PASSWORD`, `FOUNDRY_SOCK_LOG`
(socket diagnostics to a file).

## Config + persistence
- `%LOCALAPPDATA%\Foundry\foundry.json` — `serverUrl`, `username`, optional `localSandbox`
  (username/password/runnerCommand — plaintext by the SAME trade-off note as the Tauri shell),
  optional ntfy fields.
- The session token lives in the Windows credential locker, never the JSON.
- The FIRST-RUN import: the shell's `%APPDATA%\app.foundry.desktop\foundry.json` (server
  AND local-sandbox creds) is imported best-effort when our config is missing — the
  transition from the Tauri shell is seamless.
- The runner's log: `<data dir>\runner.log` (the supervisor's + the runner's stdout).

## UX notes (kept from the plan's gates)
- Enter sends in the composer (Shift+Enter = newline); Enter sends the line in the terminal.
- The terminal renders SGR colors; other VT = stripped (v1.1: raw keystrokes + full 256-palette).
- A dead chat-bound local env falls back visually to the default env (the local workspace
  re-materializes on the next local run — ADR-015).
- "Change server…"/"Configure local sandbox…" in Settings = the setup screen again
  (the shell's always-reachable setup affordance).