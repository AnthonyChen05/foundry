using System.Diagnostics;
using System.Text;

namespace Foundry.RunnerSup;

/// <summary>Roughly %LOCALAPPDATA%\Foundry — the C# app keeps the same layout as the
/// Tauri shell: config JSON + runner.log next to it.</summary>
public static class AppDirs
{
    /// <summary>%LOCALAPPDATA%\Foundry (creation is the caller's job when writing).</summary>
    public static string DataDir() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Foundry");

    public static string ConfigPath() => Path.Combine(DataDir(), "foundry.json");
    public static string RunnerLogPath() => Path.Combine(DataDir(), "runner.log");
}

public sealed record RunnerSpec(
    string ServerUrl,
    string Username,
    string Password,
    string? RunnerCommand,
    string LogPath);

/// <summary>
/// C# port of apps/desktop/src-tauri/src/supervisor.rs (the shipped Tauri shell): spawns
/// and babysits the @foundry/runner Node process — the desktop's local sandbox executor.
///
/// Entry resolution (supervisor.rs resolve_entry):
///   1. the configured runner command (full command line, double-quoted paths allowed),
///   2. the repo checkout NEXT TO THIS EXE: walk up looking for apps/runner/dist/main.js
///      (dev layouts are deeper under bin/ than the Tauri target/release — walk up to 8),
///   3. (packaged resources — later; resource copies are not configured yet, same as
///      the Tauri shell's known gap).
///
/// `node` must be on PATH; missing → log + stay down (local mode then reports
/// "no local executor" core-side). Improvements over the Tauri shell: the runner's own
/// stdout/stderr are PIPED into runner.log instead of discarded.
///
/// Restart policy: exponential backoff 2s→60s (doubled), reset when the child stayed up
/// >300s. Shutdown kills the child and joins the loop. Log format matches: "%epochms% runner: %msg%".
/// </summary>
public sealed class RunnerSupervisor : IDisposable
{
    private RunnerSpec? _spec;
    private Process? _child;
    private readonly object _gate = new();
    private CancellationTokenSource? _cts;
    private Task? _loop;
    private volatile bool _stopping;

    /// <summary>Starts the supervision loop if the runner can be resolved; no-op otherwise
    /// (all outcomes land in runner.log).</summary>
    public void Start(RunnerSpec spec)
    {
        lock (_gate)
        {
            if (_loop is not null) return; // idempotent
            _spec = spec;
            var nodeOk = ProbeNode();
            if (!nodeOk)
            {
                Log(spec, "node not found on PATH or not healthy — local sandbox disabled (see README)");
                return;
            }
            var entry = ResolveEntry(spec);
            if (entry is null)
            {
                Log(spec, "runner entry not found (no configured command, no repo layout) — local sandbox disabled");
                return;
            }
            _stopping = false;
            _cts = new CancellationTokenSource();
            Log(spec, "supervisor starting");
            _loop = Task.Run(() => LoopAsync(entry, _cts.Token), CancellationToken.None);
        }
    }

    /// <summary>Kill + join; safe to call redundantly.</summary>
    public void Dispose()
    {
        CancellationTokenSource? cts;
        lock (_gate)
        {
            _stopping = true;
            cts = _cts;
        }
        cts?.Cancel();
        KillChild("supervisor stop");
        try { _loop?.Wait(TimeSpan.FromSeconds(5)); } catch { /* torn down */ }
        cts?.Dispose();
    }

    // ------------------------------------------------------------------

    private void LoopAsync(string entryLine, CancellationToken ct)
    {
        var spec = _spec!;
        var parts = SplitCommand(entryLine);
        if (parts.Count == 0)
        {
            Log(spec, "runner command resolved to nothing — local sandbox disabled");
            return;
        }
        var program = parts[0];
        var args = parts.Skip(1).ToList();
        args.Add("--server");
        args.Add(spec.ServerUrl);
        args.Add("--user");
        args.Add(spec.Username);
        args.Add("--password");
        args.Add(spec.Password);

        var backoffMs = 2_000;
        var stableSince = (DateTime?)null;
        while (!ct.IsCancellationRequested && !_stopping)
        {
            if (stableSince is { } stable && DateTime.UtcNow - stable > TimeSpan.FromSeconds(300))
            {
                backoffMs = 2_000;
                stableSince = null;
            }
            Process? spawned = null;
            try
            {
                spawned = Spawn(program, args);
                lock (_gate)
                {
                    if (_stopping && _child is null)
                    {
                        // A stop request raced ahead of us; the shutdown path owns the child now.
                        spawned = null;
                    }
                    else
                    {
                        _child = spawned;
                    }
                }
            }
            catch (Exception ex)
            {
                Log(spec, $"runner spawn failed: {ex.Message}");
                return; // spawn failures (missing program) break the loop — supervisor.rs behavior
            }
            if (spawned is null) break;
            Log(spec, "runner spawned");
            var exit = Wait(spawned, ct);
            lock (_gate)
            {
                if (ReferenceEquals(_child, spawned)) _child = null;
            }
            Log(spec, exit is { } code ? $"runner exited ({code})" : "runner killed (supervisor stop)");
            if (ct.IsCancellationRequested || _stopping) break;
            stableSince = DateTime.UtcNow;
            try
            {
                Task.Delay(TimeSpan.FromMilliseconds(backoffMs), ct).Wait(ct);
            }
            catch (OperationCanceledException) { break; }
            backoffMs = Math.Min(backoffMs * 2, 60_000);
        }
        Log(spec, "supervisor stopped");
    }

    private Process Spawn(string program, IReadOnlyList<string> args)
    {
        var start = new ProcessStartInfo
        {
            FileName = program,
            UseShellExecute = false,
            CreateNoWindow = true, // CREATE_NO_WINDOW parity
            RedirectStandardOutput = true, // improvement: pipe runner output into the log
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var a in args)
        {
            start.ArgumentList.Add(a);
        }
        var process = Process.Start(start) ?? throw new InvalidOperationException("process start returned null");
        process.OutputDataReceived += (_, e) => { if (e.Data is not null) RunnerStdLine(e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data is not null) RunnerStdLine(e.Data); };
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return process;
    }

    private void RunnerStdLine(string line)
    {
        // The runner logs "foundry-runner: …" on stdout/stderr; the supervisor prefixes its
        // own lines "… runner: …". Keep both readable in one file.
        var spec = _spec;
        if (spec is null) return;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(spec.LogPath)!);
            File.AppendAllText(spec.LogPath, $"{EpochMs()} runner.stdout: {line}{Environment.NewLine}");
        }
        catch { /* best-effort log */ }
    }

    /// <summary>Killable wait: poll so a stop request can kill the child mid-wait.</summary>
    private int? Wait(Process child, CancellationToken ct)
    {
        while (true)
        {
            try
            {
                if (child.WaitForExit(250)) return child.ExitCode;
            }
            catch
            {
                return null;
            }
            if (ct.IsCancellationRequested || _stopping)
            {
                KillChild("supervisor stop");
                return null;
            }
        }
    }

    private void KillChild(string reason)
    {
        Process? toKill;
        lock (_gate)
        {
            toKill = _child;
            _child = null;
        }
        if (toKill is null) return;
        try
        {
            if (!toKill.HasExited)
            {
                toKill.Kill(entireProcessTree: true);
                toKill.WaitForExit(2000);
            }
        }
        catch { /* already gone */ }
        finally
        {
            try { toKill.Dispose(); } catch { /* */ }
        }
        if (_spec is not null) Log(_spec, reason);
    }

    // ------------------------------------------------------------------

    private static bool ProbeNode()
    {
        try
        {
            var psi = new ProcessStartInfo("node", "--version")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var p = Process.Start(psi);
            if (p is null) return false;
            var outp = p.StandardOutput.ReadToEnd();
            if (!p.WaitForExit(5000)) return false;
            return p.ExitCode == 0 && outp.TrimStart().StartsWith("v2", StringComparison.Ordinal); // node ≥ 22 (v2x)
        }
        catch
        {
            return false;
        }
    }

    private static string? ResolveEntry(RunnerSpec spec)
    {
        var cmd = spec.RunnerCommand?.Trim();
        if (!string.IsNullOrEmpty(cmd)) return cmd;

        // Repo checkout next to the exe: walk up until a dir containing apps/runner/dist/main.js.
        var dir = Path.GetDirectoryName(AppContext.BaseDirectory);
        for (var i = 0; i < 8 && dir is not null; i++)
        {
            var candidate = Path.Combine(dir, "apps", "runner", "dist", "main.js");
            if (File.Exists(candidate)) return $"node \"{candidate}\"";
            dir = Path.GetDirectoryName(dir);
        }
        return null;
    }

    /// <summary>Whitespace split honoring double quotes (Windows paths with spaces) — port of
    /// supervisor.rs split_command.</summary>
    private static List<string> SplitCommand(string s)
    {
        var parts = new List<string>();
        var cur = new System.Text.StringBuilder();
        var inQuotes = false;
        foreach (var c in s)
        {
            if (c == '"') inQuotes = !inQuotes;
            else if (char.IsWhiteSpace(c) && !inQuotes)
            {
                if (cur.Length > 0)
                {
                    parts.Add(cur.ToString());
                    cur.Clear();
                }
            }
            else cur.Append(c);
        }
        if (cur.Length > 0) parts.Add(cur.ToString());
        return parts;
    }

    private static void Log(RunnerSpec spec, string msg)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(spec.LogPath)!);
            File.AppendAllText(spec.LogPath, $"{EpochMs()} runner: {msg}{Environment.NewLine}");
        }
        catch { /* best-effort log */ }
    }

    private static long EpochMs() =>
        (long)(DateTimeOffset.UtcNow - DateTimeOffset.UnixEpoch).TotalMilliseconds;
}