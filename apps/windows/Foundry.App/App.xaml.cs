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
        Window.Activate();
        Host.Store.StateChanged += OnStoreChanged;
        _ = Host.Store.BootAsync();
    }

    private void OnStoreChanged(AppState s) => MarshalToUi(() => Screens.Router.OnState(Window, s));
}

/// <summary>App-owned transports + store (one composition root).</summary>
public sealed class StoreHost
{
    public AppStore Store { get; }

    public StoreHost(IPersistedSession session)
    {
        Store = new AppStore(
            url => new FoundrySocket(url, null),
            url => new FoundryRest(url),
            session,
            note => Toasts.Post(note)); // M5 wires real toasts; no-op until then
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
        WriteMeta(new Meta(session.ServerUrl, session.Username, session.NtfyUrl, session.NtfyTopic));
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

    public static string? TauriImportedUrl()
    {
        try
        {
            var path = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "app.foundry.desktop", "foundry.json");
            if (!System.IO.File.Exists(path)) return null;
            return JsonDocument.Parse(System.IO.File.ReadAllText(path)).RootElement
                .TryGetProperty("serverUrl", out var u) && u.ValueKind == JsonValueKind.String
                ? u.GetString()
                : null;
        }
        catch
        {
            return null;
        }
    }

    private sealed record Meta(string ServerUrl, string Username, string? NtfyUrl, string? NtfyTopic);

    private Meta? ReadMeta()
    {
        try
        {
            var path = Foundry.RunnerSup.AppDirs.ConfigPath();
            if (!System.IO.File.Exists(path))
            {
                var imported = TauriImportedUrl();
                if (imported is not null)
                {
                    var fresh = new Meta(imported, "admin", null, null);
                    WriteMeta(fresh);
                    return fresh;
                }
                return null;
            }
            var el = JsonDocument.Parse(System.IO.File.ReadAllText(path)).RootElement;
            return new Meta(
                el.TryGetProperty("serverUrl", out var u) && u.ValueKind == JsonValueKind.String ? u.GetString() ?? "" : "",
                el.TryGetProperty("username", out var un) && un.ValueKind == JsonValueKind.String ? un.GetString() ?? "" : "",
                el.TryGetProperty("ntfyUrl", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() : null,
                el.TryGetProperty("ntfyTopic", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null);
        }
        catch
        {
            return null;
        }
    }

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