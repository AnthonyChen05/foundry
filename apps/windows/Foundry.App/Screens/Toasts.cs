using Foundry.Store;

namespace Foundry_App.Screens;

/// <summary>
/// Push notifications (M5): WS notify.push → toast via AppNotificationManager + tap-through.
/// Stubbed to a no-op for M2 (in-app notification list only).
/// </summary>
public static class Toasts
{
    public static void Post(UiNotification note)
    {
        // M5: AppNotificationManager (unpackaged identity caveat — graceful fallback).
    }
}