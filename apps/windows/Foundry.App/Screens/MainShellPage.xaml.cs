using Foundry.Sdk;
using Foundry.Store;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Foundry_App.Screens;

/// <summary>
/// The ready-phase shell: NavigationView tab switch + the conn indicator; hosts the
/// feature pages in its own ContentFrame.
/// </summary>
public sealed partial class MainShellPage : Page
{
    public MainShellPage()
    {
        InitializeComponent();
        ContentFrame.Navigate(typeof(ChatsPage));
        var store = App.Host.Store;
        store.StateChanged += OnState;
        OnState(store.State);
        Unloaded += (_, _) => store.StateChanged -= OnState;
    }

    private void OnState(AppState s) => App.MarshalToUi(() =>
    {
        var icon = s.Conn switch
        {
            ConnStatus.Open => "●",
            ConnStatus.Connecting or ConnStatus.Reconnecting => "◌",
            _ => "○",
        };
        ConnDot.Text = $"{icon} {s.Conn}" + (s.ConnError.Length > 0 ? $" — {s.ConnError}" : "");
    });

    private void OnNavChanged(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
    {
        if (args.SelectedItem is not NavigationViewItem item || item.Tag is not string tag) return;
        var target = tag switch
        {
            "chats" => typeof(ChatsPage),
            "term" => typeof(TermPage),
            "files" => typeof(FilesPage),
            "settings" => typeof(SettingsPage),
            _ => typeof(ChatsPage),
        };
        HeaderTitle.Text = item.Content?.ToString() ?? "Chats";
        ContentFrame.Navigate(target);
    }
}