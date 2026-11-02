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
/// </summary>
public sealed partial class SetupPage : Page
{
    public SetupPage()
    {
        InitializeComponent();
        var store = App.Host.Store;
        if (store.State.ServerUrl.Length > 0)
        {
            UrlBox.Text = store.State.ServerUrl;
            return;
        }
        // Test battery (env-gated): prefill + let the first StateChanged drive on.
        var testUrl = Environment.GetEnvironmentVariable("FOUNDRY_TESTS_CORE_URL");
        if (testUrl is not null)
        {
            UrlBox.Text = testUrl;
            Status.Text = "Test URL prefilled — connect.";
        }
        else
        {
            UrlBox.PlaceholderText = "http://127.0.0.1:8787";
        }
    }

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