// Hides the extra Windows console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod supervisor;

use std::fs;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
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
 * Config is one JSON file in the OS app-config dir; the setup page reopens
 * from the app menu ("Connection → Change server…"), automatically when the
 * stored server doesn't answer at boot, and via `--reconfigure`.
 * Local-sandbox credentials are stored in plaintext in that file (documented; same trust class as the
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

/// Cheap boot-time reachability check: does a TCP connect to the URL's
/// host:port succeed within 1.5s? (DNS failure counts as unreachable — the
/// setup page then loads with the URL prefilled.) HTTP-level health stays
/// the setup page's own no-cors healthz fetch.
fn port_open(url: &tauri::Url) -> bool {
    let Some(port) = url.port_or_known_default() else {
        return true; // unknown scheme → don't second-guess, load it
    };
    let Some(host) = url.host_str() else {
        return true;
    };
    let Ok(addrs) = (host, port).to_socket_addrs() else {
        return false;
    };
    for addr in addrs {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(1_500)).is_ok() {
            return true;
        }
    }
    false
}

/// The shell's bundled-page origin (Tauri's `get_app_url` is pub(crate)):
/// Windows/Android resolve WebviewUrl::App to http://tauri.localhost, other
/// desktops to tauri://localhost.
fn app_url(path: &str) -> String {
    if cfg!(windows) {
        format!("http://tauri.localhost/{path}")
    } else {
        format!("tauri://localhost/{path}")
    }
}

/// Reopen the setup page in the main window (app menu / boot fallback).
/// This never touches config: the page prefills the saved URL itself.
fn open_firstrun(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("main window gone")?;
    let parsed: tauri::Url = app_url("firstrun.html")
        .parse()
        .map_err(|e| format!("setup URL: {e}"))?;
    window.navigate(parsed).map_err(|e| e.to_string())
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
                    // A down server means the setup screen, not a webview
                    // error page: the saved URL arrives prefilled and a
                    // Connect retry re-checks it.
                    if port_open(&parsed) {
                        WebviewUrl::External(parsed)
                    } else {
                        eprintln!("stored server {u} did not answer at boot — opening setup");
                        WebviewUrl::App("firstrun.html".into())
                    }
                }
                None => WebviewUrl::App("firstrun.html".into()),
            };
            WebviewWindowBuilder::new(app, "main", start)
                .title("Foundry")
                .inner_size(1280.0, 800.0)
                .min_inner_size(760.0, 500.0)
                .build()?;
            // The always-visible path back to setup: one small menu.
            let accelerator: Option<&str> = if cfg!(windows) { Some("Ctrl+U") } else { None };
            let change_server =
                MenuItem::with_id(app.handle(), "reconfigure", "Change server…", true, accelerator)?;
            let menu = Menu::with_items(app.handle(), &[&change_server])?;
            app.set_menu(menu)?;
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
            app.run(|app, event| {
                match event {
                    tauri::RunEvent::MenuEvent(menu) => {
                        if menu.id().as_ref() == "reconfigure" {
                            if let Err(err) = open_firstrun(app) {
                                eprintln!("reconfigure failed: {err}");
                            }
                        }
                    }
                    tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                        supervisor::shutdown();
                    }
                    _ => {}
                }
            });
            Ok(())
        });
    if let Err(err) = result {
        eprintln!("error while running Foundry shell: {err}");
        std::process::exit(1);
    }
}