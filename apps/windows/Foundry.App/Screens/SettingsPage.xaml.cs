using Foundry.Protocol;
using Foundry.Sdk;
using Foundry.Store;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Foundry_App.Screens;

/// <summary>
/// Settings: the session card (Change server = the SetupPage re-entry), the executor
/// status (ADR-015), the model catalog, the admin-provider CRUD (w/ the auto-pull result
/// display), the password change, and the notification feed. All server-owned values
/// render from the store / REST results (no local truth).
/// </summary>
public sealed partial class SettingsPage : Page
{
    private readonly AppStore _store = App.Host.Store;
    private readonly Microsoft.UI.Dispatching.DispatcherQueueTimer _renderTimer;
    private AppState? _pending;

    public SettingsPage()
    {
        InitializeComponent();
        _renderTimer = App.DispatcherQueue.CreateTimer();
        _renderTimer.Interval = TimeSpan.FromMilliseconds(60);
        _renderTimer.Tick += (_, _) =>
        {
            _renderTimer.Stop();
            if (_pending is { } s)
            {
                _pending = null;
                Render(s);
            }
        };
        _store.StateChanged += OnState;
        OnState(_store.State);
        _ = LoadProvidersAsync();
        Footer.Text = "Foundry windows " + FoundryRest.ClientVersion +
            " · web app stays served by your core for browsers";
        Unloaded += (_, _) => _store.StateChanged -= OnState;
    }

    private void OnState(AppState s) => App.MarshalToUi(() =>
    {
        _pending = s;
        if (!_renderTimer.IsRunning) _renderTimer.Start();
    });

    private void Render(AppState s)
    {
        ServerLine.Text = s.ServerUrl;
        UserLine.Text = "signed in as " + (s.Username.Length > 0 ? s.Username : "?");
        ConnLine.Text = s.Conn + (s.ConnError.Length > 0 ? " — " + s.ConnError : "");

        // executor (ADR-015)
        var exe = s.Executor;
        if (exe is null)
        {
            ExecLine.Text = "probing…";
            ExecDetail.Text = "";
            RunnerBtn.Visibility = Visibility.Collapsed;
        }
        else if (!exe.Online)
        {
            ExecLine.Text = "No local executor — chats run in server (cloud) envs.";
            ExecDetail.Text = exe.Reason is { Length: > 0 } ? "reason: " + exe.Reason : "";
            RunnerBtn.Visibility = Visibility.Visible;
            LocalNote.Text = "Enable \"Run sandboxes locally\" on the setup screen (or configure here) to host local containers.";
        }
        else
        {
            ExecLine.Text = (exe.Name ?? "executor") + (exe.Version is { Length: > 0 } v ? " v" + v : "");
            ExecDetail.Text = "docker: " + (exe.DockerAvailable is { } d ? d : "unknown") +
                (exe.WorkspaceRoot is { Length: > 0 } w ? " · workspaces: " + w : "");
            RunnerBtn.Visibility = Visibility.Visible;
            LocalNote.Text = "";
        }

        // models catalog
        var models = s.Models;
        ModelsList.Items.Clear();
        ModelsEmpty.Visibility = models.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        foreach (var m in models)
        {
            ModelsList.Items.Add(new TextBlock
            {
                Text = "• " + (m.Avatar is { Length: > 0 } ? m.Avatar + " " : "") + m.Id,
                FontFamily = new FontFamily("Consolas"),
                FontSize = 12,
                Foreground = UiTokens.TextDim,
            });
        }

        // notifications
        NotifLine.Text = s.Notifications.Count == 0
            ? "No pushes in this session. Run-finish and gate events appear here (and as toasts when enabled)."
            : "WS notify.push feed (" + s.Notifications.Count + " in this session)";
        NotifList.Items.Clear();
        foreach (var n in s.RecentNotifications)
        {
            NotifList.Items.Add(new TextBlock
            {
                Text = $"{DateTimeOffset.FromUnixTimeMilliseconds(n.AtEpochMs).LocalDateTime:HH:mm} {n.Title} — {n.Body}",
                FontSize = 12,
                TextWrapping = TextWrapping.Wrap,
            });
        }
    }

    // ---- providers (admin REST) ----

    private async Task LoadProvidersAsync()
    {
        try
        {
            var rows = await _store.ListProvidersAsync();
            ProviderRows.Children.Clear();
            foreach (var p in rows)
            {
                var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
                line.Children.Add(new TextBlock
                {
                    Text = p.Id,
                    FontFamily = new FontFamily("Consolas"),
                    FontSize = 12,
                    VerticalAlignment = VerticalAlignment.Center,
                });
                line.Children.Add(new TextBlock
                {
                    Text = " " + p.Kind + (p.HasKey ? " 🔑" : "") + (p.BaseUrl is { Length: > 0 } u ? " · " + u : ""),
                    VerticalAlignment = VerticalAlignment.Center,
                });
                var del = new Button
                {
                    Content = "delete",
                    FontSize = 11,
                    Padding = new Thickness(8, 2, 8, 2),
                };
                del.Click += async (_, _) =>
                {
                    try
                    {
                        await _store.DeleteProviderAsync(p.Id);
                        await LoadProvidersAsync();
                    }
                    catch (FoundryError err)
                    {
                        StatusLine(err.Message);
                    }
                };
                line.Children.Add(del);
                ProviderRows.Children.Add(line);
            }
            if (rows.Count == 0)
            {
                ProviderRows.Children.Add(new TextBlock
                {
                    Text = "no providers — add one (the model catalog auto-pulls)",
                    FontSize = 12,
                    Foreground = UiTokens.TextDim,
                });
            }
        }
        catch (FoundryError err)
        {
            // providers = admin REST; a read failure = surfaced, not fatal
            if (ProviderRows.Children.Count == 0)
            {
                ProviderRows.Children.Add(new TextBlock
                {
                    Text = "providers: " + err.Message,
                    FontSize = 12,
                    Foreground = UiTokens.Error,
                });
            }
        }
    }

    private void StatusLine(string text)
    {
        PassStatus.Text = text;
    }

    /// <summary>Add-provider: kind chips + base URL + vaulted key + optional model list
    /// (blank = the server auto-pulls). The result shows the pulled count / pull error.</summary>
    private async void OnAddProvider(object sender, RoutedEventArgs e)
    {
        var kind = new ComboBox { MinWidth = 200, SelectedIndex = 0 };
        kind.Items.Add("openai_compat");
        kind.Items.Add("anthropic");
        var baseUrl = new TextBox { PlaceholderText = "https://api.openai.com (or a root-relative /v1 URL)" };
        var apiKey = new PasswordBox { PlaceholderText = "API key (vaulted server-side)" };
        var models = new TextBox
        {
            PlaceholderText = "models one per line (blank = auto-pull)",
            AcceptsReturn = true,
            Height = 84,
            FontFamily = new FontFamily("Consolas"),
        };
        var status = new TextBlock { FontSize = 12, TextWrapping = TextWrapping.Wrap, MinHeight = 20 };
        var dialog = new ContentDialog
        {
            Title = "Add provider",
            XamlRoot = XamlRoot,
            PrimaryButtonText = "Save",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Primary,
        };
        var contents = new StackPanel { Spacing = 8 };
        contents.Children.Add(new TextBlock { Text = "kind", FontSize = 12 });
        contents.Children.Add(kind);
        contents.Children.Add(new TextBlock { Text = "base URL", FontSize = 12 });
        contents.Children.Add(baseUrl);
        contents.Children.Add(new TextBlock { Text = "API key", FontSize = 12 });
        contents.Children.Add(apiKey);
        contents.Children.Add(new TextBlock { Text = "models", FontSize = 12 });
        contents.Children.Add(models);
        contents.Children.Add(status);
        dialog.Content = contents;
        dialog.PrimaryButtonClick += async (_, args) =>
        {
            var url = baseUrl.Text.Trim();
            var modelList = models.Text.Split("\n").Select(l => l.Trim()).Where(l => l.Length > 0).ToList();
            if (url.Length == 0)
            {
                args.Cancel = true;
                status.Text = "base URL is required";
                return;
            }
            args.Cancel = true; // keep the dialog open until the REST round-trip returns
            dialog.IsPrimaryButtonEnabled = false;
            try
            {
                var (savedId, pulled, pullError) = await _store.UpsertProviderAsync(null, (string)kind.SelectedItem, url,
                    apiKey.Password.Length > 0 ? apiKey.Password : null,
                    models.Text.Trim().Length == 0 ? null : modelList);
                status.Text = "saved " + savedId + (pullError is { Length: > 0 }
                    ? " — pull FAILED: " + pullError
                    : pulled == true ? " — models pulled ✓" : "");
                dialog.Hide();
                await LoadProvidersAsync();
            }
            catch (FoundryError err)
            {
                status.Text = err.Message;
            }
            finally
            {
                dialog.IsPrimaryButtonEnabled = true;
            }
        };
        await dialog.ShowAsync();
    }

    // ---- other cards ----

    private async void OnReconnect(object sender, RoutedEventArgs e) => await _store.ReconnectAsync();

    /// <summary>Change server / configure the local sandbox = the SETUP page (the app's
    /// setup screen is always reachable from here — the shell-parity affordance).</summary>
    private void OnChangeServer(object sender, RoutedEventArgs e) => Router.ToSetup();

    private void OnConfigRunner(object sender, RoutedEventArgs e) => Router.ToSetup();

    private void OnSignOut(object sender, RoutedEventArgs e) => _ = _store.LogoutAsync();

    private async void OnChangePassword(object sender, RoutedEventArgs e)
    {
        var newPass = NewPass.Password;
        if (CurPass.Password.Length == 0 || newPass.Length < 8 || newPass.Length > 128)
        {
            StatusLine("current required; new password 8–128 chars");
            return;
        }
        try
        {
            await _store.ChangePasswordAsync(CurPass.Password, newPass);
            StatusLine("password changed ✓");
            CurPass.Password = NewPass.Password = "";
        }
        catch (FoundryError err)
        {
            StatusLine(err.Message);
        }
    }
}