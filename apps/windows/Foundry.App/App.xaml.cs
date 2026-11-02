using System.Text;
using System.Text.Json;
using Foundry.Sdk;
using Foundry.Store;
using Foundry_App.Screens;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.Security.Credentials;

// To learn more about the WinUI project structure, see: http://aka.ms/winui-project-info.

namespace Foundry_App;

/// <summary>
/// Application entry: builds the transports + the store and boots. The window navigates
/// per store phase: SetupPage (no server configured) → LoginPage (server, no token) →
/// MainShellPage (ready). The token lives in the OS credential locker; everything else in
/// %LOCALAPPDATA%\Foundry\foundry.json (best-effort import of the Tauri shell's config
/// when ours is missing, for a smooth transition).
/// </summary>
public partial class App : Application
{
    /// <summary>
    /// The main application window. Use <c>App.Window</c> from any class that needs
    /// the window reference (for dialogs, pickers, interop, etc.).
    /// </summary>
    public static Window Window { get; private set; } = null!;

    /// <summary>
    /// The UI thread dispatcher. Use <c>App.DispatcherQueue</c> to marshal calls to the UI
    /// thread (fully qualified in the initializer to avoid the WinRT ambiguity).
    /// </summary>
    public static Microsoft.UI.Dispatching.DispatcherQueue DispatcherQueue { get; private set; } = null!;

    /// <summary>Marshal an action onto the UI thread (store callbacks arrive on any thread).</summary>
    public static void MarshalToUi(Action action) => DispatcherQueue.TryEnqueue(() => action());

    public static StoreHost Host { get; private set; } = null!;

    /// <summary>Initializes the singleton application object.</summary>
    public App()
    {
        InitializeComponent();
        // Dark-first, like the web client: the app-level theme (covers the Mica backdrop
        // AND every brush) must be set in the ctor, before any window exists.
        RequestedTheme = ApplicationTheme.Dark;
    }

    /// <summary>Invoked when the application is launched.</summary>
    protected override void OnLaunched(Microsoft.UI.Xaml.LaunchActivatedEventArgs args)
    {
        Host = new StoreHost(new SessionFile());
        DispatcherQueue = Microsoft.UI.Dispatching.DispatcherQueue.GetForCurrentThread();
        Window = new MainWindow();
        Window.Closed += (_, _) => Host.Dispose(); // kill the runner + join on exit
        Window.Activate();
        Host.Store.StateChanged += OnStoreChanged;
        _ = Host.Store.BootAsync();
    }

    private void OnStoreChanged(AppState s) => MarshalToUi(() =>
    {
        Screens.Router.OnState(Window, s);
        if (s.Phase == "ready" && s.Conn == ConnStatus.Open)
        {
            Host.MaybeStartRunner(s.ServerUrl); // idempotent; no-op without local-sandbox creds
        }
    });
}

/// <summary>App-owned transports + store + the local-sandbox runner supervisor (ADR-015).</summary>
public sealed class StoreHost : IDisposable
{
    public AppStore Store { get; }
    private readonly SessionFile _session;
    private readonly Foundry.RunnerSup.RunnerSupervisor _runner = new();

    /// <summary>The session file (setup/config reads + localSandbox save) for the screens.</summary>
    public SessionFile Session => _session;

    private int _runnerRequested;

    public StoreHost(IPersistedSession session)
    {
        _session = (SessionFile)session;
        Store = new AppStore(
            url => new FoundrySocket(url, null),
            url => new FoundryRest(url),
            session,
            note => Toasts.Post(note)); // M5 wires real toasts; no-op until then
    }

    /// <summary>Spawn+supervise the runner when local-sandbox creds exist (idempotent;
    /// the supervisor itself stays down when node/entry are missing — its log says so).
    /// Callers: after a successful connect (the server URL is now known).</summary>
    public void MaybeStartRunner(string serverUrl)
    {
        var local = _session.ReadLocal();
        if (local is not { Enabled: true }) return;
        if (Interlocked.Exchange(ref _runnerRequested, 1) == 1) return;
        _runner.Start(new Foundry.RunnerSup.RunnerSpec(
            serverUrl,
            local.Username,
            local.Password,
            local.RunnerCommand,
            Foundry.RunnerSup.AppDirs.RunnerLogPath()));
    }

    public void Dispose()
    {
        _runner.Dispose(); // kill the child; the store's socket dies with the process
    }
}

/// <summary>
/// IPersistedSession over %LOCALAPPDATA%\Foundry\foundry.json (metadata) + the Windows
/// credential locker (session TOKEN only — never the JSON file). Logout clears the token
/// but keeps server/username (Android SessionStore parity). Best-effort import from the
/// Tauri shell's config supplies the setup prefill on transition installs.
/// </summary>
public sealed class SessionFile : IPersistedSession
{
    private const string VaultResource = "Foundry";
    private const string VaultUser = "session";

    public PersistedSession? Read()
    {
        var meta = ReadMeta();
        if (meta is null || meta.ServerUrl.Length == 0) return null;
        var token = ReadToken() ?? "";
        return new PersistedSession(meta.ServerUrl, token, meta.Username, meta.NtfyUrl, meta.NtfyTopic);
    }

    public void Save(PersistedSession session)
    {
        WriteMeta(new Meta(session.ServerUrl, session.Username, session.NtfyUrl, session.NtfyTopic, ReadMeta()?.Local));
        WriteToken(session.Token);
    }

    /// <summary>Logout: drop ONLY the token (server/username prefill survives).</summary>
    public void ClearToken() => WriteToken("");

    public void ClearAll()
    {
        var vault = new PasswordVault();
        try
        {
            foreach (var cred in vault.RetrieveAll())
            {
                if (cred.Resource == VaultResource) vault.Remove(cred);
            }
        }
        catch { /* vault unavailable */ }
        try { System.IO.File.Delete(Foundry.RunnerSup.AppDirs.ConfigPath()); } catch { /* fine */ }
    }

    // ---- the Tauri shell's config, imported best-effort (transition parity) ----
    // (full import incl. localSandbox: TauriImportedMeta, called from ReadMeta)

    public sealed record LocalSandbox(string Username, string Password, string? RunnerCommand)
    {
        public bool Enabled => Username.Length > 0 && Password.Length > 0;
    }

    private sealed record Meta(string ServerUrl, string Username, string? NtfyUrl, string? NtfyTopic, LocalSandbox? Local);

    private Meta? ReadMeta()
    {
        try
        {
            var path = Foundry.RunnerSup.AppDirs.ConfigPath();
            if (!System.IO.File.Exists(path))
            {
                var imported = TauriImportedMeta();
                if (imported is not null)
                {
                    WriteMeta(imported);
                    return imported;
                }
                return null;
            }
            var el = JsonDocument.Parse(System.IO.File.ReadAllText(path)).RootElement;
            LocalSandbox? local = null;
            if (el.TryGetProperty("localSandbox", out var ls) && ls.ValueKind == JsonValueKind.Object)
            {
                var lsUser = ls.TryGetProperty("username", out var lu) && lu.ValueKind == JsonValueKind.String ? lu.GetString() ?? "" : "";
                var lsPass = ls.TryGetProperty("password", out var lp) && lp.ValueKind == JsonValueKind.String ? lp.GetString() ?? "" : "";
                if (lsUser.Length > 0 && lsPass.Length > 0)
                {
                    local = new LocalSandbox(lsUser, lsPass,
                        ls.TryGetProperty("runnerCommand", out var rc) && rc.ValueKind == JsonValueKind.String ? rc.GetString() : null);
                }
            }
            return new Meta(
                el.TryGetProperty("serverUrl", out var u) && u.ValueKind == JsonValueKind.String ? u.GetString() ?? "" : "",
                el.TryGetProperty("username", out var un) && un.ValueKind == JsonValueKind.String ? un.GetString() ?? "" : "",
                el.TryGetProperty("ntfyUrl", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() : null,
                el.TryGetProperty("ntfyTopic", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null,
                local);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Full Tauri-shell import (serverUrl AND its localSandbox, when present).</summary>
    private static Meta? TauriImportedMeta()
    {
        try
        {
            var path = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "app.foundry.desktop", "foundry.json");
            if (!System.IO.File.Exists(path)) return null;
            var el = JsonDocument.Parse(System.IO.File.ReadAllText(path)).RootElement;
            var server = el.TryGetProperty("serverUrl", out var u) && u.ValueKind == JsonValueKind.String ? u.GetString() : null;
            if (server is null) return null;
            LocalSandbox? local = null;
            if (el.TryGetProperty("localSandbox", out var ls) && ls.ValueKind == JsonValueKind.Object)
            {
                var lsUser = ls.TryGetProperty("username", out var lu) && lu.ValueKind == JsonValueKind.String ? lu.GetString() ?? "" : "";
                var lsPass = ls.TryGetProperty("password", out var lp) && lp.ValueKind == JsonValueKind.String ? lp.GetString() ?? "" : "";
                if (lsUser.Length > 0 && lsPass.Length > 0)
                {
                    local = new LocalSandbox(lsUser, lsPass,
                        ls.TryGetProperty("runnerCommand", out var rc) && rc.ValueKind == JsonValueKind.String ? rc.GetString() : null);
                }
            }
            return new Meta(server.TrimEnd('/'), "admin", null, null, local);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>The runner's credentials change (setup page / settings): merge + rewrite.</summary>
    public void SaveLocal(LocalSandbox? local)
    {
        var meta = ReadMeta();
        if (meta is null) return;
        WriteMeta(new Meta(meta.ServerUrl, meta.Username, meta.NtfyUrl, meta.NtfyTopic, local));
    }

    public LocalSandbox? ReadLocal() => ReadMeta()?.Local;

    private void WriteMeta(Meta meta)
    {
        try
        {
            System.IO.Directory.CreateDirectory(Foundry.RunnerSup.AppDirs.DataDir());
            var json = JsonSerializer.Serialize(meta, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
                WriteIndented = true,
            });
            System.IO.File.WriteAllText(Foundry.RunnerSup.AppDirs.ConfigPath(), json, Encoding.UTF8);
        }
        catch { /* best-effort persistence */ }
    }

    // ---- token in the credential locker ----

    private static string? ReadToken()
    {
        try
        {
            var vault = new PasswordVault();
            var cred = vault.Retrieve(VaultResource, VaultUser);
            cred.RetrievePassword();
            return cred.Password.Length > 0 ? cred.Password : null;
        }
        catch
        {
            return null; // no entry
        }
    }

    private static void WriteToken(string token)
    {
        try
        {
            var vault = new PasswordVault();
            foreach (var old in vault.RetrieveAll())
            {
                if (old.Resource == VaultResource && old.UserName == VaultUser) vault.Remove(old);
            }
            if (token.Length > 0) vault.Add(new PasswordCredential(VaultResource, VaultUser, token));
        }
        catch
        {
            // no vault (rare) — the session simply won't persist
        }
    }
}