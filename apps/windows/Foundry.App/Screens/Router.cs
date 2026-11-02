using Foundry.Sdk;
using Foundry.Store;
using Foundry_App.Screens;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Foundry_App.Screens;

/// <summary>
/// Root navigation keyed off the store's phase (mirrors the Android AppNav phases):
/// boot → the setup page in a passive state; login-phase with NO configured server →
/// SetupPage (the "enter your backend address" screen); login otherwise → LoginPage
/// (server editable + credentials); ready → MainShellPage. Idempotent: same page = no-op.
/// </summary>
public static class Router
{
    private static string _current = "";

    public static void OnState(Window window, AppState s)
    {
        if (window is not MainWindow main) return;
        var frame = main.Root;
        var target = s.Phase switch
        {
            "ready" => typeof(MainShellPage),
            _ => s.ServerUrl.Length == 0 ? typeof(SetupPage) : typeof(LoginPage),
        };
        // Phase "boot" routes to setup (the first state after launch, before the session
        // file has been read). Idempotent: same target = no-op.
        if (_current == target.Name) return;
        _current = target.Name;
        frame.Navigate(target, s);
    }

    /// <summary>The settings' explicit re-entry (Change server / configure runner):
    /// navigate to setup at once; the next store state keeps it until Connect.</summary>
    public static void ToSetup()
    {
        if (App.Window is not MainWindow main) return;
        _current = "SetupPage";
        main.Root.Navigate(typeof(SetupPage), null);
    }
}