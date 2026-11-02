using Foundry.Store;
using Microsoft.Windows.AppNotifications;
using Microsoft.Windows.AppNotifications.Builder;
using Microsoft.Windows.AppLifecycle;

namespace Foundry_App.Screens;

/// <summary>
/// notify.push → Windows toasts (AppNotificationManager) + the in-app list (the store owns
/// the in-app half). Unpackaged apps: supported since WinAppSDK 1.1; recent docs re-flag
/// identity requirements, so Register() failures degrade to in-app-only quietly (the
/// NeverMiss path). Tap-through carries runId → the RunPanelVM focus.
/// </summary>
public static class Toasts
{
    private static bool _registered;
    private static bool _broken;

    public static void Register()
    {
        try
        {
            AppNotificationManager.Default.NotificationInvoked += OnInvoked;
            AppNotificationManager.Default.Register();
            _registered = true;
        }
        catch
        {
            // unpackaged identity / com-activation unavailable: in-app list only
            _broken = true;
            _registered = false;
        }
    }

    public static bool Enabled => _registered;

    private static void OnInvoked(object? sender, AppNotificationActivatedEventArgs args)
    {
        // tap-through: launch args carry runId (Arguments = a string-map)
        if (args.Arguments.TryGetValue("runId", out var runId) && runId.Length > 0)
        {
            App.MarshalToUi(() => RunPanelFocus(runId));
        }
    }

    private static void RunPanelFocus(string runId)
    {
        // Focus the run in the app's store (the timeline follows; the shell's chats page
        // reads the selection).
        _ = App.Host.Store.FocusRunAsync(runId);
    }

    public static void Post(UiNotification note)
    {
        if (!_registered || _broken) return;
        try
        {
            var builder = new AppNotificationBuilder()
                .AddText(note.Title)
                .AddText(note.Body);
            if (note.RunId is { Length: > 0 } rid)
            {
                builder.AddButton(new AppNotificationButton("View run")
                    .AddArgument("runId", rid));
            }
            AppNotificationManager.Default.Show(builder.BuildNotification());
        }
        catch
        {
            _broken = true; // one failed toast = degrade to in-app-only
        }
    }
}