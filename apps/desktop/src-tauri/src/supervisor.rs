//! Runner supervisor (ADR-015): spawns and babysits the @foundry/runner
//! Node process — the desktop's local sandbox executor.
//!
//! Resolution order for the runner entry:
//!   1. the configured runner command (a full command line, e.g.
//!      `node C:\...\apps\runner\dist\main.js`; double-quoted paths allowed),
//!   2. the repo layout NEXT TO THIS EXE (dev builds: `target/release` →
//!      `../../../apps/runner/dist/main.js`),
//!   3. the bundle resource dir (packaged installs).
//!
//! `node` must be on PATH; when missing this stays down (logged) and local
//! mode simply reports "no local executor" core-side. The runner log
//! appends to `<app-config-dir>/runner.log`.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub struct RunnerSpec {
    pub server_url: String,
    pub username: String,
    pub password: String,
    pub runner_command: Option<String>,
    pub resource_dir: Option<PathBuf>,
    pub log_path: PathBuf,
}

struct SupervisorState {
    stop: AtomicBool,
    child: Mutex<Option<Child>>,
}

static STATE: OnceLock<SupervisorState> = OnceLock::new();

fn state() -> &'static SupervisorState {
    STATE.get_or_init(|| SupervisorState {
        stop: AtomicBool::new(false),
        child: Mutex::new(None),
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn log_line(spec: &RunnerSpec, msg: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&spec.log_path) {
        let _ = writeln!(f, "{} runner: {}", now_ms(), msg);
    }
}

/// Whitespace split honoring double quotes (Windows paths with spaces).
fn split_command(s: &str) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    for c in s.chars() {
        match c {
            '"' => in_quotes = !in_quotes,
            _ if c.is_whitespace() && !in_quotes => {
                if !cur.is_empty() {
                    parts.push(std::mem::take(&mut cur));
                }
            }
            _ => cur.push(c),
        }
    }
    if !cur.is_empty() {
        parts.push(cur);
    }
    parts
}

fn entry_exists(entry: &PathBuf) -> Option<String> {
    if entry.exists() {
        Some(entry.to_string_lossy().into_owned())
    } else {
        None
    }
}

fn resolve_entry(spec: &RunnerSpec) -> Option<String> {
    if let Some(cmd) = spec.runner_command.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        return Some(cmd.to_string());
    }
    // Dev layout: <repo>/apps/runner/dist/main.js three levels up from the exe.
    if let Ok(exe) = std::env::current_exe() {
        let exe_dir = exe.parent().map(PathBuf::from);
        let mut dir = exe_dir;
        for _ in 0..3 {
            let Some(d) = dir else { break };
            if let Some(found) = entry_exists(&d.join("apps").join("runner").join("dist").join("main.js")) {
                return Some(format!("node \"{}\"", found));
            }
            dir = d.parent().map(PathBuf::from);
        }
    }
    // Packaged layout: bundled resources (runner copied to resources/runner).
    if let Some(res) = &spec.resource_dir {
        let a = res.join("resources").join("runner").join("main.js");
        let b = res.join("runner").join("main.js");
        if let Some(found) = entry_exists(&a).or_else(|| entry_exists(&b)) {
            return Some(format!("node \"{}\"", found));
        }
    }
    None
}

/// Spawns the runner with exponential-backoff restart until the shell exits.
pub fn start(spec: RunnerSpec) {
    // Missing interpreter = a log entry, not a crash.
    let node_ok = Command::new("node")
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match node_ok {
        Ok(s) if s.success() => {}
        Ok(_) => {
            log_line(&spec, "node is present but not healthy — supervisor staying down");
            return;
        }
        Err(_) => {
            log_line(&spec, "node not found on PATH — local sandbox disabled (see README)");
            return;
        }
    }
    let Some(entry_line) = resolve_entry(&spec) else {
        log_line(&spec, "runner entry not found (no configured command, no repo/resource layout) — local sandbox disabled");
        return;
    };
    let mut parts = split_command(&entry_line);
    if parts.is_empty() {
        log_line(&spec, "runner command resolved to nothing — local sandbox disabled");
        return;
    }
    let program = parts.remove(0);
    parts.push("--server".into());
    parts.push(spec.server_url.clone());
    parts.push("--user".into());
    parts.push(spec.username.clone());
    parts.push("--password".into());
    parts.push(spec.password.clone());

    state().stop.store(false, Ordering::SeqCst);
    log_line(&spec, "supervisor starting");
    thread::spawn(move || {
        let mut backoff_ms: u64 = 2_000;
        let mut stable_since: Option<Instant> = None;
        while !state().stop.load(Ordering::SeqCst) {
            if let Some(stable) = stable_since {
                if stable.elapsed() > Duration::from_secs(300) {
                    backoff_ms = 2_000;
                    stable_since = None;
                }
            }
            let mut cmd = Command::new(&program);
            cmd.args(&parts).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            }
            let spawned = cmd.spawn();
            let child = match spawned {
                Ok(c) => c,
                Err(e) => {
                    log_line(&spec, &format!("runner spawn failed: {e}"));
                    break;
                }
            };
            *state().child.lock().unwrap_or_else(|p| p.into_inner()) = Some(child);
            log_line(&spec, "runner spawned");
            // Take the child back out for the (killable) wait; a stop request
            // may already have killed it — the take returning None means the
            // shutdown path owns the lifecycle now.
            let lock_result = match state().child.lock() {
                Ok(guard) => Ok(guard),
                Err(poisoned) => Err(poisoned.into_inner()),
            };
            let mut child = match lock_result {
                Ok(mut guard) => guard.take(),
                Err(_) => None,
            };
            match child.as_mut() {
                Some(c) => {
                    let code = wait_child(c);
                    match code {
                        Some(exit) => log_line(&spec, &format!("runner exited ({exit})")),
                        None => log_line(&spec, "runner killed (supervisor stop)"),
                    }
                }
                None => {
                    log_line(&spec, "runner wait handed over to shutdown");
                    break;
                }
            }
            if state().stop.load(Ordering::SeqCst) {
                break;
            }
            stable_since.get_or_insert(Instant::now());
            thread::sleep(Duration::from_millis(backoff_ms));
            backoff_ms = (backoff_ms * 2).min(60_000);
        }
        log_line(&spec, "supervisor stopped");
    });
}

/// Killable wait: poll so a stop request can kill the child mid-wait.
fn wait_child(child: &mut Child) -> Option<i32> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.code(),
            Ok(None) => {
                if state().stop.load(Ordering::SeqCst) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                thread::sleep(Duration::from_millis(250));
            }
            Err(_) => return None,
        }
    }
}

/// Called by the app's exit path (and safe to call redundantly).
pub fn shutdown() {
    if let Some(state) = STATE.get() {
        state.stop.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = state.child.lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}