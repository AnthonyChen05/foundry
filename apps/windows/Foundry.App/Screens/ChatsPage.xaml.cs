using Foundry.Protocol;
using Foundry.Sdk;
using Foundry.Store;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;

namespace Foundry_App.Screens;

/// <summary>
/// The chats page (list | detail): the VM binds incrementally; the page translates user
/// intent into store commands (create/select/send w/ idem). M2 slice: plain + agent
/// (no tool policy / location chips yet — M3).
/// </summary>
public sealed partial class ChatsPage : Page
{
    public ChatsVm Vm { get; } = new();

    private readonly AppStore _store = App.Host.Store;
    private string _selectedModel = "";

    /// <summary>Coalescing: bursty store state (streaming deltas, connects) renders at most
    /// once per tick instead of per event.</summary>
    private readonly Microsoft.UI.Dispatching.DispatcherQueueTimer _renderTimer;
    private AppState? _pending;

    public ChatsPage()
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
        Unloaded += (_, _) =>
        {
            _store.StateChanged -= OnState;
            _renderTimer.Stop();
        };
    }

    private void OnState(AppState s) => App.MarshalToUi(() =>
    {
        _pending = s;
        if (!_renderTimer.IsRunning) _renderTimer.Start(); // one pass now-ish, coalesced onward
    });

    private void Render(AppState s)
    {
        Vm.Apply(s);
        // Auto-select the first catalog model whenever the pick is empty (hub rejects
        // model-less sends; Android parity). Fires on catalog arrival, not once-ever.
        if (_selectedModel.Length == 0
            && ModelBox.ItemsSource is System.Collections.ObjectModel.ObservableCollection<ModelRow> models
            && models.Count > 0)
        {
            ModelBox.SelectedIndex = 0;
        }
    }

    private void OnChatSelected(object sender, SelectionChangedEventArgs e)
    {
        if (ChatList.SelectedItem is ChatRow row)
        {
            _ = _store.SelectChatAsync(row.Id);
        }
    }

    private void OnNewChat(object sender, RoutedEventArgs e)
    {
        _ = _store.CreateChatAsync(null);
    }

    private void OnModelChanged(object sender, SelectionChangedEventArgs e)
    {
        _selectedModel = (ModelBox.SelectedItem as ModelRow)?.Id ?? "";
    }

    private void OnAgentToggled(object sender, RoutedEventArgs e) { /* read at send */ }

    private void OnComposerKey(object sender, KeyRoutedEventArgs args)
    {
        // Enter = send; Shift+Enter = newline.
        var shift = Microsoft.UI.Input.InputKeyboardSource
            .GetKeyStateForCurrentThread(Windows.System.VirtualKey.Shift)
            .HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
        if (args.Key == Windows.System.VirtualKey.Enter && !shift)
        {
            args.Handled = true;
            Send();
        }
    }

    private void OnSend(object sender, RoutedEventArgs e) => Send();

    private void Send()
    {
        var content = Composer.Text;
        if (content.Trim().Length == 0) return;
        Composer.Text = "";
        var model = _selectedModel.Length > 0 ? _selectedModel : null;
        var agent = AgentSwitch.IsOn ? new AgentParams(true, null, null) : null;
        _ = _store.SendMessageAsync(_store.State.ActiveChatId, content, model, agent);
    }
}
