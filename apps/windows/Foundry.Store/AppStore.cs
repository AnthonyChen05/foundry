using System.Text;
using System.Text.Json;
using Foundry.Protocol;
using Foundry.Sdk;

namespace Foundry.Store;

/// <summary>Session persistence seam (App implements with json + DPAPI; tests use fakes).</summary>
public interface IPersistedSession
{
    PersistedSession? Read();
    void Save(PersistedSession session);
    void ClearToken();       // logout: drop ONLY the token (server/username prefill survives)
    void ClearAll();
}

/// <summary>
/// The single app store over server-authoritative state — a 1:1 behavioral port of the
/// Android AppStore.kt (itself a port of apps/web/src/lib/foundry.svelte.ts):
/// - commands go out, events + refetches come back; NO local truth.
/// - event intake mirrors Android exactly (incl. gate state injection, draft lifecycle,
///   run terminal-state refetches, live→replay replacement, notification/terminal handling,
///   executor status). Fixes vs Android (documented quirks we do NOT port): ntfy wipe on
///   re-login (we keep ntfy settings), live-row key collisions are not a display concern here.
/// - callbacks from the socket arrive on its reader thread; all state mutation is inside
///   _lock; StateChanged fires with the latest snapshot (subscribers marshal to the UI thread).
/// - sys.resync → channel-scoped refetch; run.status terminal → replay refresh; run.gate_request
///   → run.get for the ride-along gates; core-restart cursor_ahead resyncs hit the same paths.
/// </summary>
public sealed class AppStore
{
    private readonly object _lock = new();
    private AppState _app = new();
    private readonly IFdSocket _socket;
    private readonly IFdRest _rest;
    private readonly IPersistedSession _session;
    private readonly Action<UiNotification>? _onNotify;
    public Func<Task>? OnRunWaitingApproval { get; set; } // VM hook (e.g. toast/navigation), fires on UI-safe side

    /// <summary>
    /// Transport seams: IFdSocket + IFdRest ship in Foundry.Sdk next to their concrete
    /// implementations (FoundrySocket raises OnEvent/OnResync/OnStatus on its own reader
    /// thread; the store mutates under _lock, VMs marshal to the UI thread).
    /// </summary>
    public AppStore(IFdSocket socket, IFdRest rest, IPersistedSession session, Action<UiNotification>? onNotify = null)
    {
        _socket = socket;
        _rest = rest;
        _session = session;
        _onNotify = onNotify;
        socket.OnEvent += Intake;
        socket.OnResync += IntakeResync;
        socket.OnStatus += IntakeStatus;
    }

    /// <summary>Raised with the fresh snapshot after every mutation (any thread).</summary>
    public event Action<AppState>? StateChanged;

    public AppState State { get { lock (_lock) return _app; } }

    // ------------------------------------------------------------------
    // boot / login / logout (Android AppStore: 121-234)
    // ------------------------------------------------------------------

    /// <summary>Boot: persisted session → connect; none → login screen (prefilled).</summary>
    public async Task BootAsync()
    {
        var saved = _session.Read();
        if (saved is null || saved.IsEmpty)
        {
            Set(phase: "login", serverUrl: saved?.ServerUrl ?? "", username: saved?.Username ?? "admin",
                conn: ConnStatus.Offline, connError: "");
            return;
        }
        Set(phase: "login", serverUrl: saved.ServerUrl, username: saved.Username, // UI shows login while connecting
            conn: ConnStatus.Connecting, connError: "");
        try
        {
            await ConnectInAsync(saved.ServerUrl, saved.Token, saved.Username).ConfigureAwait(false);
        }
        catch (FoundryError err)
        {
            // A rejected/expired token falls back to login (prefilled), like the references.
            _session.ClearToken();
            Set(phase: "login", conn: ConnStatus.Offline, connError: err.Message);
        }
    }

    public async Task LoginAsync(string serverUrlInput, string username, string password)
    {
        var serverUrl = BaseUrlNormalizer.FromLoginInput(serverUrlInput);
        Set(conn: ConnStatus.Connecting, connError: "", serverUrl: serverUrl, username: username.Trim());
        try
        {
            var login = await _rest.Login(username.Trim(), password).ConfigureAwait(false);
            // NOTE (fix vs Android): keep persisted ntfy settings across re-logins.
            var keep = _session.Read();
            _session.Save(new PersistedSession(serverUrl, login.SessionToken, username.Trim(), keep?.NtfyUrl, keep?.NtfyTopic));
            await ConnectInAsync(serverUrl, login.SessionToken, username.Trim()).ConfigureAwait(false);
        }
        catch (FoundryError err)
        {
            Set(conn: ConnStatus.Offline, connError: err.Message, phase: "login");
        }
    }

    public async Task LogoutAsync()
    {
        _session.ClearToken();
        await _socket.CloseAsync().ConfigureAwait(false);
        var keep = _session.Read();
        ResetState();
        Set(phase: "login", conn: ConnStatus.Offline, connError: "",
            serverUrl: keep?.ServerUrl ?? "", username: keep?.Username ?? "");
    }

    public async Task ReconnectAsync()
    {
        var s = State;
        if (s.ServerUrl.Length == 0 || _socket.Token is not { Length: > 0 }) return;
        Set(connError: "");
        await _socket.CloseAsync().ConfigureAwait(false);
        try
        {
            await ConnectInAsync(s.ServerUrl, _socket.Token, s.Username).ConfigureAwait(false);
        }
        catch (FoundryError err)
        {
            _session.ClearToken();
            Set(phase: "login", conn: ConnStatus.Offline, connError: err.Message);
        }
    }

    private async Task ConnectInAsync(string serverUrl, string token, string username)
    {
        Set(conn: ConnStatus.Connecting, connError: "", serverUrl: serverUrl, username: username,
            phase: "login");
        _rest.Token = token;
        _socket.SetToken(token);
        try
        {
            await _socket.ConnectAsync(CancellationToken.None).ConfigureAwait(false);
        }
        catch (FoundryError err) when (err.IsAuthFailure)
        {
            // Stale/revoked token: forget it, return to the login gate (web store do the same).
            _session.ClearToken();
            Set(conn: ConnStatus.Offline, phase: "login", connError: err.Message);
            return;
        }
        Set(phase: "ready", conn: ConnStatus.Open);
        _socket.StartReconnectLoop();
        await RefreshChatsAsync().ConfigureAwait(false);
        await RefreshModelsAsync().ConfigureAwait(false);
        await ProbeExecutorAsync().ConfigureAwait(false);
    }

    // ------------------------------------------------------------------
    // commands (idem keys per user action; Android/web parity)
    // ------------------------------------------------------------------

    public static string Idem(string prefix) => $"{prefix}-{Guid.NewGuid():N}";

    public async Task CreateChatAsync(string? title = null)
    {
        var chat = await _socket.ChatCreate(title, model: null).ConfigureAwait(false);
        lock (_lock)
        {
            _app = _app with
            {
                // Upsert + newest-first ordering (Android createChat)
                Chats = new Dictionary<string, ChatSummary>(_app.Chats) { [chat.Id] = chat },
                ChatOrder = [chat.Id, .. _app.ChatOrder.Where(id => id != chat.Id)],
                ActiveChatId = chat.Id,
            };
        }
        NotifyChanged();
    }

    public async Task SelectChatAsync(string chatId)
    {
        Set(activeChatId: chatId);
        var needHistory = State.Messages.TryGetValue(chatId, out _);
        if (!needHistory)
        {
            await RefreshMessagesAsync(chatId).ConfigureAwait(false);
        }
    }

    public async Task<Run?> SendMessageAsync(string chatId, string content, string? model, AgentParams? agent)
    {
        string chatToUse = chatId.Length > 0 ? chatId : State.ActiveChatId;
        if (chatToUse.Length == 0) return null;
        var idem = Idem("chat");
        string sendRunId = "", sendConv = "";
        try
        {
            (sendRunId, sendConv) = await _socket.ChatSend(chatToUse, content, model, agent, idem).ConfigureAwait(false);
        }
        catch (FoundryError err)
        {
            // Denied/capacity/unknown-model sends fail BEFORE persistence — surface + retryable.
            Set(connError: err.Message);
            return null;
        }
        var runId = sendRunId;
        string defaultModel = model ?? "";
        if (defaultModel.Length == 0 && State.Chats.TryGetValue(chatToUse, out var chat) && chat.Model is not null)
        {
            defaultModel = chat.Model;
        }
        var stub = new Run(runId, sendConv, RunStatuses.Queued, RunTriggers.Chat,
            defaultModel, new RunBudgets(25, 100000, 5, 600000), NowIso(), 0, null, null, null, null);
        NoteRun(runId, stub, autoFollow: true);
        lock (_lock)
        {
            _app = _app with { SelectedRunId = runId };
        }
        NotifyChanged();
        return runId.Length == 0 ? null : await _socket.RunGet(runId).ConfigureAwait(false);
    }

    public Task CancelRunAsync(string runId) => _socket.RunCancel(runId, Idem("cancel"));

    /// <summary>Approve/deny. Scope: null on deny AND on approve-once; session/when approving
    /// otherwise (both reference clients do this — deny carries no scope at all).</summary>
    public Task ResolveGateAsync(string runId, string gateId, bool approve, string? scope)
    {
        var effective = approve ? scope : null;
        if (approve && effective == GateScopes.Once) effective = null;
        var idem = Idem("gate");
        return _socket.RunApprove(new RunApproveParams(runId, gateId, approve, effective), idem);
    }

    public async Task FocusRunAsync(string runId)
    {
        Set(selectedRunId: runId);
        try
        {
            await RefreshRunAsync(runId).ConfigureAwait(false);
            await RefreshRunEventsAsync(runId).ConfigureAwait(false);
        }
        catch (FoundryError) { /* run may be unknown to this token — ignore */ }
    }

    public Task PushChatToCloudAsync(string chatId) => _rest.PushChat(chatId);

    // term/files passthroughs live in the screen VMs (they need env binding from the ACTIVE chat)
    public string? EnvIdFor(string chatId)
    {
        return State.Chats.TryGetValue(chatId, out var chat) ? chat.EnvId : null;
    }

    public Task<List<FileEntry>> FilesListAsync(string path, string? envId) => _socket.FilesList(path, envId);
    public Task<FilesReadResult> FilesReadAsync(string path, string? envId) => _socket.FilesRead(path, envId);
    public Task FilesWriteAsync(string path, string content, string? envId) => _socket.FilesWrite(path, content, null, envId, Idem("files"));
    public Task FilesMkdirAsync(string path, bool recursive, string? envId) => _socket.FilesMkdir(path, recursive, envId, Idem("files"));
    public Task FilesRmAsync(string path, bool recursive, string? envId) => _socket.FilesRm(path, recursive, envId, Idem("files"));
    public Task<TermOpenResult> TermOpenAsync(string? envId) => _socket.TermOpen(envId, Idem("term"));
    public Task TermInputAsync(string termId, string data) => _socket.TermInput(termId, data, null, Idem("term-in"));
    public Task TermInputAsync64(string termId, byte[] bytes) =>
        _socket.TermInput(termId, Convert.ToBase64String(bytes), b64: true, Idem("term-in"));
    public Task TermResizeAsync(string termId, int cols, int rows) => _socket.TermResize(termId, cols, rows, Idem("term"));
    public Task TermCloseAsync(string termId) => _socket.TermClose(termId, Idem("term"));

    public Task<List<FoundryRest.ProviderRow>> ListProvidersAsync() => _rest.ListProviders();
    public Task ChangePasswordAsync(string currentPassword, string newPassword) => _rest.ChangePassword(currentPassword, newPassword);

    public async Task<string?> UpsertProviderAsync(string? id, string kind, string baseUrl, string? apiKey, IReadOnlyList<string>? models)
    {
        var (upsertedId, _, _, _) = await _rest.UpsertProvider(id, kind, baseUrl, apiKey, models).ConfigureAwait(false);
        await RefreshModelsAsync().ConfigureAwait(false);
        return upsertedId;
    }

    public Task DeleteProviderAsync(string id) => _rest.DeleteProvider(id);

    // ------------------------------------------------------------------
    // event intake (Android AppStore.handleEvent 247-401, exact semantics)
    // ------------------------------------------------------------------

    internal void Intake(string eventName, string channel, long seq, JsonElement? payload)
    {
        switch (eventName)
        {
            case "chat.delta":
            {
                var runId = GetStr(payload, "runId");
                var delta = GetStr(payload, "delta");
                if (runId is not { Length: > 0 } || delta is not { Length: > 0 }) return;
                var chatId = Channels.ChatId(channel);
                if (chatId.Length == 0) return;
                lock (_lock)
                {
                    var drafts = Shallow(_app.Drafts);
                    if (drafts.TryGetValue(runId, out var d))
                    {
                        drafts[runId] = d with { Text = d.Text + delta };
                    }
                    else
                    {
                        drafts[runId] = new Draft(chatId, delta);
                    }
                    _app = _app with { Drafts = drafts };
                }
                break;
            }
            case "chat.final":
            {
                var msg = payload is { ValueKind: JsonValueKind.Object } p && p.TryGetProperty("message", out var m)
                    ? m.Deserialize(WireJsonContext.Default.Message)
                    : null;
                var chatId = Channels.ChatId(channel);
                if (msg is null || chatId.Length == 0) break;
                lock (_lock)
                {
                    var messages = Shallow(_app.Messages);
                    if (messages.TryGetValue(chatId, out var list))
                    {
                        var copy = list.ToList();
                        copy.Add(msg);
                        messages[chatId] = copy;
                    }
                    else
                    {
                        messages[chatId] = [msg];
                    }
                    var drafts = Shallow(_app.Drafts);
                    var dead = _app.Drafts.Where(kv => kv.Value.ChatId == chatId).Select(kv => kv.Key).ToList();
                    foreach (var runId in dead)
                    {
                        drafts.Remove(runId);
                    }
                    _app = _app with { Messages = messages, Drafts = drafts };
                }
                break;
            }
            case "run.status":
            {
                var runId = GetStr(payload, "runId");
                var status = GetStr(payload, "status");
                if (runId is not { Length: > 0 } || status is not { Length: > 0 }) return;
                var error = GetStr(payload, "error");
                NoteRunStatus(runId, status, error);
                if (status == RunStatuses.WaitingApproval)
                {
                    _ = FireWaitingApprovalHookAsync();
                    // waiting_approval refresh run → gates ride-along (Android:327)
                    _ = FireAndForgetAsync(() => RefreshRunAsync(runId));
                }
                if (status is RunStatuses.Done or RunStatuses.Failed or RunStatuses.Cancelled or RunStatuses.Timeout)
                {
                    lock (_lock)
                    {
                        var drafts = Shallow(_app.Drafts);
                        drafts.Remove(runId); // terminal: drop the optimistic draft
                        _app = _app with { Drafts = drafts };
                    }
                    _ = FireAndForgetAsync(() => RefreshRunEventsAsync(runId));
                }
                break;
            }
            case "run.gate_request":
            {
                var gate = GateParsing.Parse(payload, openState: true); // payload = Gate WITHOUT state → open
                if (gate is null || gate.GateId.Length == 0) return;
                AddLive(Channels.RunId(channel), eventName, seq, payload);
                NoteRun(gate.RunId);
                lock (_lock)
                {
                    var gates = Shallow(_app.Gates);
                    var list = gates.TryGetValue(gate.RunId, out var existing)
                        ? existing.Where(g => g.GateId != gate.GateId).ToList()
                        : [];
                    list.Add(gate);
                    gates[gate.RunId] = list;
                    // An approval is actionable now: surface the chat + inspector (Android parity:
                    // the web store switches view; here the VM handles it via StateChanged).
                    _app = _app with { Gates = gates, SelectedRunId = _app.SelectedRunId.Length == 0 ? gate.RunId : _app.SelectedRunId };
                }
                break;
            }
            case "run.gate_resolved":
            {
                var runId = Channels.RunId(channel);
                if (runId.Length == 0) return;
                AddLive(runId, eventName, seq, payload);
                var gateId = GetStr(payload, "gateId") ?? "";
                lock (_lock)
                {
                    if (gateId.Length > 0 && _app.Gates.TryGetValue(runId, out var list))
                    {
                        var kept = list.Where(g => g.GateId != gateId).ToList();
                        var gates = Shallow(_app.Gates);
                        if (kept.Count == 0) gates.Remove(runId);
                        else gates[runId] = kept;
                        _app = _app with { Gates = gates };
                    }
                }
                break;
            }
            case "run.tool_call":
            case "run.tool_result":
            case "run.usage":
            {
                var runId = Channels.RunId(channel);
                if (runId.Length == 0) return;
                AddLive(runId, eventName, seq, payload);
                NoteRun(runId);
                break;
            }
            case "notify.push":
            {
                var note = new UiNotification(
                    GetStr(payload, "title") ?? "",
                    GetStr(payload, "body") ?? "",
                    GetStr(payload, "runId"),
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                lock (_lock)
                {
                    var notes = _app.Notifications.ToList();
                    notes.Add(note);
                    if (notes.Count > 20) notes.RemoveAt(0);
                    _app = _app with { Notifications = notes };
                }
                _onNotify?.Invoke(note);
                break;
            }
            case "executor.status":
            {
                var info = payload is { ValueKind: JsonValueKind.Object } p
                    ? p.Deserialize(WireJsonContext.Default.ExecutorInfo)
                    : null;
                lock (_lock)
                {
                    _app = _app with { Executor = info ?? new ExecutorInfo(false, null, null, null, null, null) };
                }
                break;
            }
            case "term.data":
            {
                var termId = Channels.TermId(channel);
                if (termId.Length == 0) return;
                var data = GetStr(payload, "data") ?? "";
                if (data.Length == 0) return; // nothing to append
                var b64 = payload is { ValueKind: JsonValueKind.Object } p && p.TryGetProperty("b64", out var b) && b.ValueKind == JsonValueKind.True;
                var text = b64 ? TryDecodeB64(data) : data;
                if (text is null) return;
                lock (_lock)
                {
                    var terminals = Shallow(_app.Terminals);
                    if (terminals.TryGetValue(termId, out var session))
                    {
                        terminals[termId] = session.Append(text);
                    }
                    else
                    {
                        terminals[termId] = new TermSession(termId, text);
                    }
                    _app = _app with { Terminals = terminals };
                }
                break;
            }
            case "term.exit":
            {
                var termId = Channels.TermId(channel);
                long? code = payload is { ValueKind: JsonValueKind.Object } p
                    && p.TryGetProperty("code", out var c)
                    && c.ValueKind == JsonValueKind.Number
                    && c.TryGetInt64(out var n) ? n : null;
                lock (_lock)
                {
                    var terminals = Shallow(_app.Terminals);
                    if (terminals.TryGetValue(termId, out var session))
                    {
                        terminals[termId] = session with { ExitCode = code };
                    }
                    else
                    {
                        terminals[termId] = new TermSession(termId, "") { ExitCode = code };
                    }
                    _app = _app with { Terminals = terminals };
                }
                break;
            }
        }
        NotifyChanged();
    }

    internal void IntakeResync(string channel)
    {
        _ = FireAndForgetAsync(() => ResyncRefetchAsync(channel));
    }

    internal void IntakeStatus(string status)
    {
        Set(conn: status);
        switch (status)
        {
            case ConnStatus.Closed when _socket.AuthFailed:
                _session.ClearToken();
                ResetState();
                Set(phase: "login", conn: ConnStatus.Offline, connError: "session expired — sign in again");
                break;
        }
    }

    private async Task ResyncRefetchAsync(string channel)
    {
        // sys.resync (gap_exceeds_buffer / cursor_ahead after a core restart): the channel
        // state is unknown — refetch server truth (web store refetchChannel port).
        try
        {
            if (Channels.ChatId(channel) is { Length: > 0 } chatId)
            {
                await RefreshChatsAsync().ConfigureAwait(false);
                if (State.Messages.TryGetValue(chatId, out _))
                {
                    await RefreshMessagesAsync(chatId).ConfigureAwait(false);
                }
                return;
            }
            if (Channels.RunId(channel) is { Length: > 0 } runId)
            {
                await RefreshRunAsync(runId).ConfigureAwait(false);
                await RefreshRunEventsAsync(runId).ConfigureAwait(false);
            }
        }
        catch (FoundryError) { /* channel may be unknown now — tolerate */ }
    }

    // ------------------------------------------------------------------
    // refetches
    // ------------------------------------------------------------------

    public async Task RefreshChatsAsync()
    {
        try
        {
            var chats = await _socket.ChatList().ConfigureAwait(false);
            lock (_lock)
            {
                var chatsDict = new Dictionary<string, ChatSummary>();
                foreach (var c in chats)
                {
                    chatsDict[c.Id] = c;
                }
                var order = chats.Select(c => c.Id).ToList(); // server returns updatedAt desc
                if (_app.ActiveChatId.Length == 0 && chats.Count > 0)
                {
                    _app = _app with { Chats = chatsDict, ChatOrder = order, ActiveChatId = chats[0].Id };
                }
                else
                {
                    _app = _app with { Chats = chatsDict, ChatOrder = order };
                }
            }
            NotifyChanged();
        }
        catch (FoundryError err)
        {
            Set(connError: err.Message);
        }
    }

    public async Task RefreshModelsAsync()
    {
        try
        {
            var models = await _socket.Models().ConfigureAwait(false);
            lock (_lock)
            {
                _app = _app with { Models = models };
            }
            NotifyChanged();
        }
        catch (FoundryError) { /* catalog optional at boot */ }
    }

    public async Task ProbeExecutorAsync()
    {
        ExecutorInfo info;
        try
        {
            info = await _socket.ExecStatus().ConfigureAwait(false);
        }
        catch (FoundryError)
        {
            info = new ExecutorInfo(false, null, null, null, null, null);
        }
        lock (_lock)
        {
            _app = _app with { Executor = info };
        }
        NotifyChanged();
    }

    public async Task RefreshMessagesAsync(string chatId)
    {
        var messages = await _socket.ChatHistory(chatId).ConfigureAwait(false);
        lock (_lock)
        {
            var messagesDict = Shallow(_app.Messages);
            messagesDict[chatId] = messages;
            _app = _app with { Messages = messagesDict };
        }
        NotifyChanged();
    }

    private async Task RefreshRunAsync(string runId)
    {
        var run = await _socket.RunGet(runId).ConfigureAwait(false);
        lock (_lock)
        {
            var runs = Shallow(_app.Runs);
            runs[runId] = run;
            _app = _app with { Runs = runs };
            var gates = Shallow(_app.Gates);
            if (run.Gates is not { Count: > 0 })
            {
                if (gates.ContainsKey(runId) && gates[runId].Count > 0) gates[runId] = [];
            }
            else
            {
                gates[runId] = run.Gates;
            }
            _app = _app with { Gates = gates };
        }
        if (run.ConversationId is { Length: > 0 } chatId && State.Messages.TryGetValue(chatId, out _))
        {
            // Tool messages + the final assistant message land server-side (Android refreshRun).
            await RefreshMessagesAsync(chatId).ConfigureAwait(false);
        }
        NotifyChanged();
    }

    private async Task RefreshRunEventsAsync(string runId)
    {
        try
        {
            var items = await _socket.RunEvents(runId).ConfigureAwait(false);
            lock (_lock)
            {
                var events = Shallow(_app.Events);
                events[runId] = items;
                var live = Shallow(_app.Live);
                live.Remove(runId); // replay replaces optimistic live items
                _app = _app with { Events = events, Live = live };
            }
            NotifyChanged();
        }
        catch (FoundryError)
        {
            // run may not be visible yet — live frames still show
        }
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    private void NoteRunStatus(string runId, string status, string? error)
    {
        lock (_lock)
        {
            var runs = Shallow(_app.Runs);
            if (runs.TryGetValue(runId, out var run))
            {
                runs[runId] = run with
                {
                    Status = status,
                    Error = error is { Length: > 0 } ? error : null,
                };
            }
            else
            {
                runs[runId] = new Run(runId, null, status, RunTriggers.Chat, "",
                    new RunBudgets(0, 0, 0, 0), NowIso(), 0, error is { Length: > 0 } ? error : null, null, null, null);
            }
            _app = _app with { Runs = runs, RunOrder = AppendUnique(_app.RunOrder, runId) };
        }
    }

    private void NoteRun(string runId, Run? stub = null, bool autoFollow = false)
    {
        lock (_lock)
        {
            var runs = Shallow(_app.Runs);
            if (stub is not null)
            {
                runs[runId] = stub;
            }
            else if (!runs.ContainsKey(runId))
            {
                runs[runId] = new Run(runId, null, RunStatuses.Running, RunTriggers.Chat, "",
                    new RunBudgets(0, 0, 0, 0), NowIso(), 0, null, null, null, null);
            }
            var order = AppendUnique(_app.RunOrder, runId);
            var selected = _app.SelectedRunId;
            if (autoFollow && selected.Length == 0)
            {
                var runsRun = runs[runId];
                if (runsRun.ConversationId is null or { Length: 0 } || runsRun.ConversationId == _app.ActiveChatId)
                {
                    selected = runId;
                }
            }
            _app = _app with { Runs = runs, RunOrder = order, SelectedRunId = selected };
        }
    }

    private void AddLive(string runId, string type, long seq, JsonElement? payload)
    {
        if (runId.Length == 0) return;
        lock (_lock)
        {
            var live = Shallow(_app.Live);
            var list = live.TryGetValue(runId, out var existing) ? existing.ToList() : [];
            list.Add(new LiveEvent(seq, type, payload is { ValueKind: JsonValueKind.Object } p ? (object)p : payload, NowIso()));
            if (list.Count > 400) list.RemoveAt(0);
            live[runId] = list;
            _app = _app with { Live = live };
        }
    }

    private void Set(
        string? phase = null,
        string? conn = null,
        string? connError = null,
        string? serverUrl = null,
        string? username = null,
        string? activeChatId = null,
        string? selectedRunId = null)
    {
        bool activeChanged = false, selectedChanged = false, serverChanged = false, userChanged = false,
             phaseChanged = false, connChanged = false, errChanged = false, selChanged = false;
        lock (_lock)
        {
            var app = _app;
            phaseChanged = phase is not null && app.Phase != phase;
            connChanged = conn is not null && app.Conn != conn;
            errChanged = connError is not null && app.ConnError != connError;
            serverChanged = serverUrl is not null && app.ServerUrl != serverUrl;
            userChanged = username is not null && app.Username != username;
            activeChanged = activeChatId is not null && app.ActiveChatId != activeChatId;
            selChanged = selectedRunId is not null && app.SelectedRunId != selectedRunId;
            _app = app with
            {
                Phase = phase ?? app.Phase,
                Conn = conn ?? app.Conn,
                ConnError = connError ?? app.ConnError,
                ServerUrl = serverUrl ?? app.ServerUrl,
                Username = username ?? app.Username,
                ActiveChatId = activeChatId ?? app.ActiveChatId,
                SelectedRunId = selectedRunId ?? app.SelectedRunId,
            };
        }
        if (phaseChanged || connChanged || errChanged || serverChanged || userChanged || activeChanged || selChanged)
        {
            NotifyChanged();
        }
    }

    private void ResetState()
    {
        lock (_lock)
        {
            var serverUrl = _app.ServerUrl;
            var username = _app.Username;
            _app = new AppState { ServerUrl = serverUrl, Username = username };
        }
    }

    private void NotifyChanged()
    {
        AppState snapshot;
        lock (_lock)
        {
            snapshot = _app;
        }
        StateChanged?.Invoke(snapshot);
    }

    private static Dictionary<string, V> Shallow<V>(IReadOnlyDictionary<string, V> source) => new(source);

    private static IReadOnlyList<string> AppendUnique(IReadOnlyList<string> list, string id) =>
        list.Contains(id) ? list : [.. list, id];

    private static string NowIso() => DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", System.Globalization.CultureInfo.InvariantCulture);

    private static string? GetStr(JsonElement? payload, string key)
    {
        if (payload is not { ValueKind: JsonValueKind.Object } p) return null;
        return p.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    }


    private static string? TryDecodeB64(string data)
    {
        try
        {
            return Encoding.UTF8.GetString(Convert.FromBase64String(data));
        }
        catch
        {
            return null;
        }
    }

    private async Task FireWaitingApprovalHookAsync()
    {
        try
        {
            if (OnRunWaitingApproval is { } hook) await hook().ConfigureAwait(false);
        }
        catch { /* hook failures never disturb intake */ }
    }

    private static async Task FireAndForgetAsync(Func<Task> action)
    {
        try
        {
            await action().ConfigureAwait(false);
        }
        catch (FoundryError) { /* tolerated: refetches are best-effort */ }
        catch (Exception) { /* never let intake await */ }
    }
}

/// <summary>An open terminal scrollback (cap 100k chars, Android parity) + lifecycle.</summary>
public sealed record TermSession(string TermId, string Text)
{
    public long? ExitCode { get; init; }

    public TermSession Append(string more)
    {
        var text = Text + more;
        if (text.Length > 100_000) text = text[^100_000..];
        return this with { Text = text };
    }
}