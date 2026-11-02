using Foundry.Protocol;
using Foundry.Sdk;
using Foundry.Store;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;

namespace Foundry_App.Screens;

/// <summary>
/// The chats page (list | messages | run inspector): the VM binds; the page translates
/// user intent into store commands (create/select/send/cancel/approve w/ idem).
/// The inspector shows the ACTIVE run — status, gate cards (once/session/always), cancel,
/// timeline (replay + live merged, live rows coalesced as they flood).
/// </summary>
public sealed partial class ChatsPage : Page
{
    public ChatsVm Vm { get; } = new();

    private readonly AppStore _store = App.Host.Store;
    private string _selectedModel = "";
    private string _lastRunKey = ""; // runId@eventsLength, to rebuild only the inspector on change

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
        if (!_renderTimer.IsRunning) _renderTimer.Start();
    });

    private void Render(AppState s)
    {
        Vm.Apply(s);
        AutoPickModel(s);
        RenderComposerState(s);
        RenderInspector(s);
    }

    private void AutoPickModel(AppState s)
    {
        if (_selectedModel.Length == 0
            && ModelBox.ItemsSource is System.Collections.ObjectModel.ObservableCollection<ModelRow> models
            && models.Count > 0)
        {
            ModelBox.SelectedIndex = 0;
        }
    }

    // ---- composer-state: model validity + the local-exec chip (ADR-015 executor gate) ----

    private void RenderComposerState(AppState s)
    {
        var exe = s.Executor;
        var online = exe is { Online: true };
        LocBtn.IsEnabled = online;
        if (!online)
        {
            LocBtn.Content = exe is { Online: false } ? "Local exec: unavailable" : "Local exec: checking…";
        }
        else
        {
            var docker = exe!.DockerAvailable is not false;
            LocBtn.Content = _execLocal
                ? "Executes: LOCAL (Docker)"
                : docker ? "Executes: cloud (local exec available)" : "Local exec: Docker off";
            LocBtn.IsEnabled = docker;
        }
        // The chat's server-side binding (ADR-015) shows + offers push migration.
        var boundLocal = s.Chats.TryGetValue(s.ActiveChatId, out var chat)
            && chat.Location is { Length: > 0 } loc;
        if (boundLocal && chat!.Location == "local")
        {
            LocBtn.Content = "Executes: LOCAL (chat-bound)";
        }
        PushBtn.Visibility = boundLocal && chat!.Location == "local"
            ? Visibility.Visible
            : Visibility.Collapsed;
    }

    private void OnPush(object sender, RoutedEventArgs e)
    {
        var chatId = _store.State.ActiveChatId;
        if (chatId.Length == 0) return;
        _ = _store.PushChatToCloudAsync(chatId);
    }

    private bool _execLocal;

    // ---- inspector (the selected/newest run) ----

    private void RenderInspector(AppState s)
    {
        Run? run = s.Runs.TryGetValue(s.SelectedRunId, out var sel) ? sel : null;
        if (run is null)
        {
            // newest run of the active chat (the store's runOrder is newest-last)
            for (var i = s.RunOrder.Count - 1; i >= 0; i--)
            {
                var candidate = s.Runs.TryGetValue(s.RunOrder[i], out var r) ? r : null;
                if (candidate is not null && candidate.ConversationId == s.ActiveChatId)
                {
                    run = candidate;
                    break;
                }
            }
        }

        // Timeline rows: replay (Events) + live (Live) merged, coalesced by key.
        var rowCount = 0;
        if (run is not null)
        {
            s.Events.TryGetValue(run.Id, out var canon);
            s.Live.TryGetValue(run.Id, out var live);
            rowCount = (canon?.Count ?? 0) + (live?.Count ?? 0);
        }
        var key = run?.Id + "@" + rowCount + "@" + (run?.Status ?? "");
        if (key == _lastRunKey) return;
        _lastRunKey = key;

        if (run is null)
        {
            RunTitle.Text = "No run yet";
            RunStatus.Text = "Send a message (agent on) to watch the run here.";
            GatesPanel.Children.Clear();
            TimelineList.Items.Clear();
            CancelBtn.Visibility = Visibility.Collapsed;
            return;
        }
        RunTitle.Text = "run " + (run.Id.Length > 12 ? run.Id[..12] + "…" : run.Id);
        RunStatus.Text = run.Status + (run.Error is { Length: > 0 } ? " — " + run.Error : "") +
            (run.Model.Length > 0 ? " · " + run.Model : "");
        CancelBtn.Visibility = run.Status is RunStatuses.Queued or RunStatuses.Running or RunStatuses.WaitingApproval
            ? Visibility.Visible
            : Visibility.Collapsed;

        // ---- gates ----
        GatesPanel.Children.Clear();
        if (s.Gates.TryGetValue(run.Id, out var gates) && gates.Count > 0)
        {
            foreach (var gate in gates)
            {
                GatesPanel.Children.Add(new GateCard(gate, (approve, scope) =>
                    _ = _store.ResolveGateAsync(run.Id, gate.GateId, approve, scope)));
            }
        }

        // ---- timeline ----
        TimelineList.Items.Clear();
        if (s.Events.TryGetValue(run.Id, out var canonRows))
        {
            foreach (var row in canonRows)
            {
                AddTimelineRow(row.Type, row.Payload, live: false);
            }
        }
        if (s.Live.TryGetValue(run.Id, out var liveRows))
        {
            foreach (var row in liveRows)
            {
                AddTimelineRow(row.Type, row.Payload, live: true);
            }
        }
    }

    private void AddTimelineRow(string type, object? payload, bool live)
    {
        var row = TimelineDescribe.From(type, payload, live);
        if (row is null) return;
        var text = new TextBlock
        {
            FontFamily = new FontFamily("Consolas"),
            FontSize = 11,
            TextWrapping = TextWrapping.Wrap,
            // live rows tinted; errors tinted (TimelineDescribe's own text carries ✓/✗ markers)
            Foreground = row.Kind == "error" || row.Text.StartsWith("✗")
                ? UiTokens.Error
                : live ? UiTokens.Ok : UiTokens.TextDim,
            Text = (live ? "● " : "") + row.Text,
        };
        TimelineList.Items.Add(text);
    }

    private void OnCancel(object sender, RoutedEventArgs e)
    {
        var runId = _lastRunKey[.._lastRunKey.IndexOf('@')] is { Length: > 0 } id ? id : "";
        if (runId.Length > 0) _ = _store.CancelRunAsync(runId);
    }

    // ---- composer actions ----

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

    private void OnLocation(object sender, RoutedEventArgs e)
    {
        _execLocal = !_execLocal;
    }

    /// <summary>Tool-policy flyout → the map sent with chat.send (once=ask means ASK via gates).</summary>
    private static string PolicyOf(ComboBox box) => (box.SelectedIndex) switch
    {
        0 => GatePolicies.Ask,
        1 => GatePolicies.Always,
        2 => GatePolicies.Session, // session-scoped pre-approval (UI wording: "always (session)")
        3 => GatePolicies.Deny,
        _ => GatePolicies.Ask,
    };

    private void OnPolicy(object sender, RoutedEventArgs e) { /* flyout handles itself */ }

    private void OnComposerKey(object sender, KeyRoutedEventArgs args)
    {
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
        var local = _execLocal;
        var agent = AgentSwitch.IsOn
            ? new AgentParams(
                true,
                new Dictionary<string, string>
                {
                    ["shell"] = PolicyOf(PolicyShell),
                    ["write_file"] = PolicyOf(PolicyWrite),
                    ["read_file"] = PolicyOf(PolicyRead),
                },
                local ? "local" : null)
            : null;
        if (agent is not null && agent.ToolPolicy is { } p && p.All(kv => kv.Value == GatePolicies.Ask))
        {
            // All-ask = the server's default; omit for a smaller frame (web parity).
            ((Dictionary<string, string>)agent.ToolPolicy!).Clear();
        }
        _ = _store.SendMessageAsync(_store.State.ActiveChatId, content, model, agent);
    }
}

/// <summary>An approval-gate card: tool + scope buttons (once/session/always/deny).</summary>
public interface IGateResolver
{
    void Resolve(bool approve, string? scope);
}

public sealed class GateCard : StackPanel
{
    public GateCard(Gate gate, Action<bool, string?> resolve)
    {
        Spacing = 8;

        var head = new TextBlock
        {
            Text = "Approval needed: " + gate.Tool,
            FontWeight = Microsoft.UI.Text.FontWeights.SemiBold,
        };
        var argsText = gate.Args is System.Text.Json.JsonElement el && el.ValueKind == System.Text.Json.JsonValueKind.Object
            ? el.GetRawText()
            : "";
        var body = new TextBlock
        {
            FontFamily = new FontFamily("Consolas"),
            FontSize = 11,
            TextWrapping = TextWrapping.Wrap,
            MaxHeight = 90,
            Text = argsText.Length > 400 ? argsText[..400] + "…" : argsText,
            Foreground = UiTokens.TextDim,
        };
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        row.Children.Add(MakeBtn("Approve once", () => resolve(true, GateScopes.Once)));
        row.Children.Add(MakeBtn("Session", () => resolve(true, GateScopes.Session)));
        row.Children.Add(MakeBtn("Always", () => resolve(true, GateScopes.Always)));
        row.Children.Add(MakeBtn("Deny", () => resolve(false, null)));
        Children.Add(head);
        if (argsText.Length > 0) Children.Add(body);
        Children.Add(row);
    }

    private static Button MakeBtn(string label, Action onClick)
    {
        var b = new Button { Content = label, FontSize = 12, Padding = new Thickness(10, 4, 10, 4) };
        b.Click += (_, _) => onClick();
        return b;
    }
}