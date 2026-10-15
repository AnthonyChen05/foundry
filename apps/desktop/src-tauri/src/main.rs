// Hides the extra Windows console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod supervisor;

use std::fs;
use std::path::PathBuf;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/**
 * Shell design (build-order P4 #3, "Tauri shell reusing the web app UI" +
 * ADR-015 "dynamic container support"):
 *
 * The shell owns two decisions and nothing else — (1) which server origin the
 * window loads, and (2) whether the LOCAL sandbox runner is enabled: stored
 * owner credentials (username/password) let the shell spawn+supervise the
 * runner process (@foundry/runner), which speaks the executor plane to the
 * core. The web UI in the window stays dumb: it authenticates to the core
 * itself and gets NO shell commands (capabilities cover only the bundled
 * first-run page); the runner connection is the shell's own WS session.
 *
 * Config is one JSON file in the OS app-config dir; `--reconfigure` (or
 * deleting the file) reopens the first-run picker. Local-sandbox credentials
 * are stored in plaintext in that file (documented; same trust class as the
 * server's .env).
 */

#[derive(serde::Serialize, serde::Deserialize)]
struct LocalSandbox {
    username: String,
    password: String,
    #[serde(rename = "runnerCommand")]
    runner_command: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct ShellConfig {
    #[serde(rename = "serverUrl")]
    server_url: Option<String>,
    #[serde(rename = "localSandbox", skip_serializing_if = "Option::is_none")]
    local_sandbox: Option<LocalSandbox>,
}

fn config_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("foundry.json"))
}

fn load_config(app: &tauri::AppHandle) -> ShellConfig {
    let Some(path) = config_path(app) else {
        return ShellConfig { server_url: None, local_sandbox: None };
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(ShellConfig { server_url: None, local_sandbox: None })
}

fn save_config(app: &tauri::AppHandle, cfg: &ShellConfig) -> Result<(), String> {
    let Some(path) = config_path(app) else {
        return Err("no app config dir".into());
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

fn resource_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok()
}

fn open_server(app: &tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed: tauri::Url = url
        .parse()
        .map_err(|e| format!("invalid URL: {e}"))?;
    let window = app
        .get_webview_window("main")
        .ok_or("main window gone")?;
    window
        .navigate(parsed)
        .map_err(|e| e.to_string())
}

/// Called by the first-run page after it has verified the URL answers
/// healthz (the page does that itself with a no-cors fetch; the shell never
/// talks HTTP). Stores the URL and moves the window onto it.
#[tauri::command]
fn set_server_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let url = url.trim_end_matches('/').to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("server URL must be http(s)".into());
    }
    let mut cfg = load_config(&app);
    cfg.server_url = Some(url.clone());
    save_config(&app, &cfg)?;
    open_server(&app, url)
}

/// Prefill for the first-run page.
#[tauri::command]
fn get_server_url(app: tauri::AppHandle) -> Option<String> {
    load_config(&app).server_url
}

/// Local-sandbox view for the first-run page — the password is never echoed.
#[derive(serde::Serialize)]
struct LocalSandboxView {
    enabled: bool,
    username: String,
    #[serde(rename = "hasPassword")]
    has_password: bool,
    #[serde(rename = "runnerCommand")]
    runner_command: Option<String>,
}

#[tauri::command]
fn get_local_sandbox(app: tauri::AppHandle) -> Option<LocalSandboxView> {
    let cfg = load_config(&app);
    cfg.local_sandbox.map(|ls| LocalSandboxView {
        enabled: true,
        username: ls.username.clone(),
        has_password: !ls.password.is_empty(),
        runner_command: ls.runner_command.clone(),
    })
}

/// Enable (or, with an empty password, disable) the local sandbox runner.
/// The password is stored in the shell config (plaintext, documented) and
/// passed ONLY to the runner process as its login credential. The JS side
/// invokes with camelCase (`runnerCommand`) — tauri maps snake_case params.
#[tauri::command]
fn set_local_sandbox(
    app: tauri::AppHandle,
    username: String,
    password: String,
    runner_command: Option<String>,
) -> Result<(), String> {
    let mut cfg = load_config(&app);
    if password.trim().is_empty() {
        cfg.local_sandbox = None; // disable
    } else {
        let user = username.trim().to_string();
        if user.is_empty() {
            return Err("username is required when enabling the local sandbox".into());
        }
        cfg.local_sandbox = Some(LocalSandbox {
            username: user,
            password: password.trim().to_string(),
            runner_command: runner_command.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        });
    }
    save_config(&app, &cfg)
}

fn main() {
    let reconfigure = std::env::args().any(|a| a == "--reconfigure");
    let result = tauri::Builder::default()
        .setup(move |app| {
            let cfg = load_config(&app.handle());
            let stored = if reconfigure { None } else { cfg.server_url.clone() };
            let start: WebviewUrl = match stored {
                Some(u) => {
                    let parsed: tauri::Url =
                        u.parse().map_err(|e| format!("invalid stored URL: {e}"))?;
                    WebviewUrl::External(parsed)
                }
                None => WebviewUrl::App("firstrun.html".into()),
            };
            WebviewWindowBuilder::new(app, "main", start)
                .title("Foundry")
                .inner_size(1280.0, 800.0)
                .min_inner_size(760.0, 500.0)
                .build()?;
            // Local sandbox (ADR-015): spawn+supervise the runner when creds
            // exist and this is not a --reconfigure run (the user is picking a
            // NEW server; the runner follows after the config saves… on the
            // next app start — keep the shell's lifecycle predictable).
            if !reconfigure {
                if let Some(ls) = cfg.local_sandbox {
                    let server_url = cfg.server_url.clone().unwrap_or_default();
                    supervisor::start(supervisor::RunnerSpec {
                        server_url,
                        username: ls.username,
                        password: ls.password,
                        runner_command: ls.runner_command,
                        resource_dir: resource_dir(&app.handle()),
                        log_path: app
                            .path()
                            .app_config_dir()
                            .unwrap_or_else(|_| PathBuf::from("."))
                            .join("runner.log"),
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_server_url,
            set_server_url,
            get_local_sandbox,
            set_local_sandbox,
        ])
        .build(tauri::generate_context!())
        .and_then(|app| {
            app.run(|_app, event| {
                if matches!(
                    event,
                    tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
                ) {
                    supervisor::shutdown();
                }
            });
            Ok(())
        });
    if let Err(err) = result {
        eprintln!("error while running Foundry shell: {err}");
        std::process::exit(1);
    }
}