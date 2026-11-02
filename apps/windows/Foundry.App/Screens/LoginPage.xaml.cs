using Foundry.Sdk;
using Foundry.Store;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Foundry_App.Screens;

/// <summary>
/// Sign-in screen: prefilled server (editable — server switching works from here too),
/// owner username/password. While connecting the inputs disable; the store flips phase to
/// ready (router follows) or surfaces the error. On boot-with-token this page shows a
/// brief "connecting" state (Android parity) before the shell appears.
/// </summary>
public sealed partial class LoginPage : Page
{
    public LoginPage()
    {
        InitializeComponent();
        var store = App.Host.Store;
        ServerBox.Text = store.State.ServerUrl;
        if (store.State.Username is { Length: > 0 } u)
        {
            UserBox.Text = u;
        }
        store.StateChanged += OnState;
        OnState(store.State);
        Unloaded += (_, _) => store.StateChanged -= OnState;

        // Test battery (env-gated): aim at the TEST core, prefill credentials, auto sign-in
        // so the UIA run can drive the rest. Real users never hit this (env unset).
        var testUrl = Environment.GetEnvironmentVariable("FOUNDRY_TESTS_CORE_URL");
        var testPw = Environment.GetEnvironmentVariable("FOUNDRY_TESTS_PASSWORD");
        if (testUrl is not null && testPw is not null)
        {
            if (BaseUrlNormalizer.StripTrailingSlash(store.State.ServerUrl)
                != BaseUrlNormalizer.StripTrailingSlash(testUrl))
            {
                store.ConfigureServer(testUrl);
                ServerBox.Text = testUrl;
            }
            PassBox.Password = testPw;
            _ = store.LoginAsync(ServerBox.Text, UserBox.Text, testPw);
        }
    }

    private void OnState(AppState s)
    {
        // UI-thread: Router marshals StateChanged to the dispatcher before page updates.
        App.MarshalToUi(() =>
        {
            var busy = s.Conn == ConnStatus.Connecting;
            GoBtn.IsEnabled = !busy
                && ServerBox.Text.Trim().Length > 0
                && UserBox.Text.Trim().Length > 0;
            GoBtn.Content = busy && s.Phase != "ready" ? "Connecting…" : "Sign in";
            if (busy)
            {
                ServerBox.IsEnabled = false;
                UserBox.IsEnabled = false;
                PassBox.IsEnabled = false;
            }
            else
            {
                ServerBox.IsEnabled = true;
                UserBox.IsEnabled = true;
                PassBox.IsEnabled = true;
            }
            Status.Text = s.ConnError.Length > 0 ? s.ConnError : "";
            Status.Foreground = s.ConnError.Length > 0 ? UiTokens.Error : UiTokens.Clear;
        });
    }

    private void OnSignIn(object sender, RoutedEventArgs e)
    {
        Status.Text = "";
        App.MarshalToUi(() => { });
        _ = App.Host.Store.LoginAsync(
            ServerBox.Text,
            UserBox.Text,
            PassBox.Password);
    }
}