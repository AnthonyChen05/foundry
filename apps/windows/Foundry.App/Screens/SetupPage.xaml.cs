using System.Net.Http;
using Foundry.Sdk;
using Foundry.Store;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Foundry_App.Screens;

/// <summary>
/// First-run setup: enter the backend server address; the page probes /healthz (plain
/// network GET — native clients face no CORS) and only then hands the URL to the store
/// (ConfigureServer: persisted meta w/o token → relaunch lands on Login, prefilled).
/// Optional local-sandbox section (ADR-015): stores runner owner credentials for the
/// supervised @foundry/runner; the Tauri shell's saved values prefill (full import).
/// </summary>
public sealed partial class SetupPage : Page
{
    public SetupPage()
    {
        InitializeComponent();
        var session = App.Host.Session;
        var existing = session.Read();
        if (existing?.ServerUrl is { Length: > 0 } saved)
        {
            UrlBox.Text = saved;
        }
        var local = session.ReadLocal();
        if (local is { Enabled: true } ls)
        {
            LocalBox.IsChecked = true;
            LocalFields.Visibility = Visibility.Visible;
            if (ls.Username.Length > 0) LocalUser.Text = ls.Username;
            LocalPass.PlaceholderText = "password (saved — type to change)";
            if (ls.RunnerCommand is { Length: > 0 } cmd) LocalCmd.Text = cmd;
        }
    }

    private void OnLocalToggled(object sender, RoutedEventArgs e) =>
        LocalFields.Visibility = LocalBox.IsChecked == true ? Visibility.Visible : Visibility.Collapsed;

    private async void OnConnect(object sender, RoutedEventArgs e)
    {
        var input = UrlBox.Text.Trim();
        var url = BaseUrlNormalizer.FromLoginInput(input);
        if (url.Length == 0)
        {
            Status.Text = "Enter a server address first.";
            return;
        }
        ConnectBtn.IsEnabled = false;
        Status.Text = $"Checking {url} …";
        var alive = await ReachableAsync(url);
        if (!alive)
        {
            ConnectBtn.IsEnabled = true;
            Status.Text = $"No server answered at {url} — is the core running?";
            return;
        }
        var session = App.Host.Session;
        if (LocalBox.IsChecked == true)
        {
            var user = LocalUser.Text.Trim();
            var pass = LocalPass.Password;
            var prev = session.ReadLocal();
            var unchanged = prev is { Enabled: true } p
                && p.Username == user
                && pass.Length == 0; // password left blank = keep the saved one
            if (!unchanged && (user.Length == 0 || pass.Length == 0))
            {
                Status.Text = "Runner username and password are required for the local sandbox.";
                ConnectBtn.IsEnabled = true;
                return;
            }
            var command = LocalCmd.Text.Trim();
            session.SaveLocal(unchanged
                ? prev
                : new SessionFile.LocalSandbox(user, pass, command.Length > 0 ? command : null));
        }
        else if (session.ReadLocal() is { Enabled: true })
        {
            session.SaveLocal(null); // explicit disable
        }
        App.Host.Store.ConfigureServer(url);
        // Router follows the store phase; the login page (server prefilled) comes up.
    }

    private static async Task<bool> ReachableAsync(string url)
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(4) };
            using var resp = await http.GetAsync(url.TrimEnd('/') + "/healthz");
            return resp.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }
}