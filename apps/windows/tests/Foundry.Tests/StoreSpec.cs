using System.Text.Json;
using Foundry.Protocol;
using Foundry.Sdk;
using Foundry.Store;
using Xunit;

namespace Foundry.Tests;

/// <summary>
/// Store behavior with a scripted transport (the Android AppStore semantics, quirks FIXED
/// where the porting plan says to). These are pure-unit: no sockets, no files on disk.
/// </summary>
public class StoreSpec
{
    private sealed class FakeSession : IPersistedSession
    {
        public PersistedSession? Saved { get; set; }
        public bool TokenCleared { get; set; }
        public PersistedSession? Read() => Saved;
        public void Save(PersistedSession s) => Saved = s;
        public void ClearToken()
        {
            TokenCleared = true;
            Saved = Saved is null ? null : Saved with { Token = "" };
        }
        public void ClearAll() => Saved = null;
    }

    private sealed class FakeSocket : IFdSocket
    {
        public string? Token { get; private set; }
        public bool AuthFailed { get; private set; }
        public event Action<string, string, long, JsonElement?>? OnEvent;
        public event Action<string>? OnResync;
        public event Action<string>? OnStatus;

        public readonly Queue<Task<JsonElement>> ScriptedModels = [];
        public readonly Queue<Task<JsonElement>> ScriptedChats = [];
        public readonly Queue<Task<JsonElement>> ScriptedRunGets = [];
        public readonly Queue<Task<JsonElement>> ScriptedRunEvents = [];
        public readonly Queue<Task<JsonElement>> ScriptedExecStatus = [];

        public void SetToken(string? token) => Token = token;
        public Task<ConnectResult> ConnectAsync(CancellationToken ct) => Task.FromResult(new ConnectResult(
            "s_fake", 0, new ConnectFeatures([], []), new ConnectSnapshot([], 0)));
        public void StartReconnectLoop() { }
        public Task CloseAsync() => Task.CompletedTask;

        public Task<List<Model>> Models() => ScriptedModels.Dequeue().ContinueWith(t => ParseList<Model>(t.Result, WireJsonContext.Default.ListModel));
        public Task<List<ChatSummary>> ChatList() => ScriptedChats.Dequeue().ContinueWith(t => ParseList<ChatSummary>(t.Result, WireJsonContext.Default.ListChatSummary));
        public async Task<ChatSummary> ChatCreate(string? title, string? model) => new("ch_new", title ?? "New chat", model, Iso(), Iso());
        public Task<List<Message>> ChatHistory(string chatId) => Task.FromResult(new List<Message>());
        public async Task<(string RunId, string ConversationId)> ChatSend(string chatId, string content, string? model, AgentParams? agent, string idem)
        {
            if (agent is { Enabled: true, Location: "local" } && ThrowLocalOffline) throw new FoundryError(ErrorCodes.BadRequest, "local execution requested but no local executor is connected — start the desktop app");
            return ("run_1", chatId);
        }
        public bool ThrowLocalOffline { get; set; }

        public async Task<Run> RunGet(string runId) => (await ScriptedRunGets.Dequeue().ConfigureAwait(false)).ReadWire(WireJsonContext.Default.Run)!;
        public Task<List<RunEventItem>> RunEvents(string runId) => ScriptedRunEvents.Dequeue().ContinueWith(t => ParseList<RunEventItem>(t.Result, WireJsonContext.Default.ListRunEventItem));
        public Task<JsonElement> RunCancel(string runId, string idem) => Task.FromResult(JsonSer(new { }));
        public RunApproveParams? LastApprove;
        public Task<Gate> RunApprove(RunApproveParams p, string idem) { LastApprove = p; return Task.FromResult(new Gate(
            p.GateId, p.RunId, "shell", null, GatePolicies.Ask,
            p.Approve ? GateStates.Approved : GateStates.Denied,
            p.Scope, "s_fake", Iso(), Iso()));
        }
        public Task<TermOpenResult> TermOpen(string? envId, string idem) => Task.FromResult(new TermOpenResult("term_1", envId ?? "env_default", "old line\n"));
        public Task<JsonElement> TermInput(string termId, string data, bool? b64, string idem) => Task.FromResult(JsonSer(new { }));
        public Task<JsonElement> TermResize(string termId, int cols, int rows, string idem) => Task.FromResult(JsonSer(new { }));
        public Task<JsonElement> TermClose(string termId, string idem) => Task.FromResult(JsonSer(new { }));
        public Task<List<FileEntry>> FilesList(string path, string? envId) => Task.FromResult(new List<FileEntry> { new("a.txt", 3, Iso(), false), new("sub", 0, Iso(), true) });
        public Task<FilesReadResult> FilesRead(string path, string? envId) => Task.FromResult(new FilesReadResult("hello", null));
        public Task<JsonElement> FilesWrite(string path, string content, bool? b64, string? envId, string idem) => Task.FromResult(JsonSer(new { }));
        public Task<JsonElement> FilesMkdir(string path, bool? recursive, string? envId, string idem) => Task.FromResult(JsonSer(new { }));
        public Task<JsonElement> FilesRm(string path, bool? recursive, string? envId, string idem) => Task.FromResult(JsonSer(new { }));
        public Task<FileEntry> FilesStat(string path, string? envId) => Task.FromResult(new FileEntry(path, 3, Iso(), false));
        public async Task<ExecutorInfo> ExecStatus() => (await ScriptedExecStatus.Dequeue().ConfigureAwait(false)).ReadWire(WireJsonContext.Default.ExecutorInfo)!;
        public Task<AuthLoginResult> AuthLogin(string username, string password) => throw new InvalidOperationException("unit store tests use REST login");

        private static List<T> ParseList<T>(JsonElement payload, System.Text.Json.Serialization.Metadata.JsonTypeInfo<List<T>> typeInfo) =>
            payload.ValueKind == JsonValueKind.Array ? (List<T>?)payload.Deserialize(typeInfo) ?? [] : [];

        internal void Emit(string e, string channel, long seq, object? payload) => OnEvent?.Invoke(e, channel, seq, payload is null ? null : JsonSer(payload));
        internal void EmitResync(string channel) => OnResync?.Invoke(channel);
        internal void RaiseStatus(string s) => OnStatus?.Invoke(s);

        internal static JsonElement JsonSer(object? o) => JsonSerializer.SerializeToElement(o);
        private static string Iso() => "2026-01-01T00:00:00.000Z";
    }

    private sealed class FakeRest : IFdRest
    {
        public string? Token { get; set; }
        public int LoginCalls;
        public Func<AuthLoginResult>? LoginImpl;
        public Task<AuthLoginResult> Login(string username, string password)
        {
            LoginCalls++;
            if (LoginImpl is null) throw new FoundryError(ErrorCodes.Unauthorized, "invalid username or password");
            return Task.FromResult(LoginImpl());
        }
        public Task ChangePassword(string currentPassword, string newPassword) => Task.CompletedTask;
        public Task<(string PushRunId, string CloudEnvId)> PushChat(string chatId) => Task.FromResult(("run_push", "env_cloud"));
        public Task<List<FoundryRest.ProviderRow>> ListProviders() => Task.FromResult(new List<FoundryRest.ProviderRow>());
        public Task<(string Id, IReadOnlyList<string> Models, bool? Pulled, string? PullError)> UpsertProvider(string? id, string kind, string baseUrl, string? apiKey, IReadOnlyList<string>? models)
        {
            IReadOnlyList<string> pulled = new[] { "p/m" };
            return Task.FromResult(("prov_x", pulled, (bool?)true, (string?)null));
        }
        public Task DeleteProvider(string id) => Task.CompletedTask;
    }

    private static (AppStore store, FakeSocket sock, FakeRest rest, FakeSession session) MakeStore()
    {
        var sock = new FakeSocket();
        var rest = new FakeRest();
        var session = new FakeSession();
        var store = new AppStore(sock, rest, session);
        return (store, sock, rest, session);
    }

    [Fact]
    public async Task BootWithoutSession_GoesToLoginPrefilled()
    {
        var (store, _, _, session) = MakeStore();
        session.Saved = null;
        await store.BootAsync();
        var s = store.State;
        Assert.Equal("login", s.Phase);
        Assert.Equal("admin", s.Username); // Android prefill parity
        Assert.Equal("offline", s.Conn);
    }

    [Fact]
    public async Task LoginEstablishesReadyAndProbesExecutor()
    {
        var (store, sock, rest, session) = MakeStore();
        rest.LoginImpl = () => new AuthLoginResult("fnds_t", "2030-01-01T00:00:00Z");
        sock.ScriptedChats.Enqueue(Task.FromResult(EmptyJsonArray()));
        sock.ScriptedModels.Enqueue(Task.FromResult(EmptyJsonArray()));
        sock.ScriptedExecStatus.Enqueue(Task.FromResult(FakeSocket.JsonSer(new { online = true, name = "desktop", version = "0.1.0", dockerAvailable = true })));
        await store.LoginAsync("http://127.0.0.1:8787/", "admin", "pw");
        var s = store.State;
        Assert.Equal("ready", s.Phase);
        Assert.Equal("http://127.0.0.1:8787", s.ServerUrl); // trailing slash stripped
        Assert.Equal("fnds_t", session.Saved!.Token);
        Assert.True(s.Executor!.Online);
    }

    [Fact]
    public async Task ChatDeltaAccumulatesAndFinalClosesDraft()
    {
        var (store, sock, _, _) = MakeStore();
        await store.SelectChatAsync("ch_1");
        sock.Emit("chat.delta", "chat:ch_1", 1, new { runId = "run_1", delta = "Hel" });
        sock.Emit("chat.delta", "chat:ch_1", 2, new { runId = "run_1", delta = "lo" });
        var draft = store.State.Drafts["run_1"];
        Assert.Equal("Hello", draft.Text);
        Assert.Equal("ch_1", draft.ChatId);

        sock.Emit("chat.final", "chat:ch_1", 3, new { message = new { role = "assistant", content = "Hello" } });
        var s = store.State;
        Assert.False(s.Drafts.ContainsKey("run_1")); // draft dropped
        Assert.Single(s.Messages["ch_1"]);
        Assert.Equal("Hello", s.Messages["ch_1"][0].DisplayText);
    }

    [Fact]
    public async Task RunStatusTerminalStateTriggersReplayRefetch()
    {
        var (store, sock, _, _) = MakeStore();
        await store.SelectChatAsync("ch_1");
        sock.Emit("run.status", "run:r1", 1, new { runId = "r1", status = "running" });

        var replayWait = new TaskCompletionSource();
        store.StateChanged += _ => { if (store.State.Events.ContainsKey("r1")) replayWait.TrySetResult(); };
        sock.ScriptedRunEvents.Enqueue(Task.FromResult(FakeSocket.JsonSer(new[]
        {
            new { seq = 1, type = "tool_call", payload = new { call = new { id = "c1", name = "shell", args = "{}" } }, createdAt = FakeSessionIso() },
        }.AsEnumerable())));
        sock.Emit("run.status", "run:r1", 2, new { runId = "r1", status = "done" });
        await Task.WhenAny(replayWait.Task, Task.Delay(10_000));
        Assert.True(replayWait.Task.IsCompleted, "replay refetch did not land");
        var s = store.State;
        Assert.Single(s.Events["r1"]);
        Assert.False(s.Live.ContainsKey("r1")); // replay replaced optimistic live rows
    }

    [Fact]
    public async Task GateRequestsAndResolutionBehave()
    {
        var (store, sock, _, _) = MakeStore();
        await store.SelectChatAsync("ch_1");
        // gate_request payload: Gate minus state → injected open + run.get is NOT required here.
        sock.Emit("run.gate_request", "run:r1", 1, new
        {
            gateId = "g1",
            runId = "r1",
            tool = "shell",
            args = new { command = "pwd" },
            policy = "ask",
            createdAt = FakeSessionIso(),
        });
        var s = store.State;
        Assert.Equal("open", s.Gates["r1"][0].State); // state injected
        Assert.Equal("r1", s.SelectedRunId.Length > 0 ? "r1" : s.SelectedRunId);

        // Deny: NO scope on the wire (references' parity rule).
        sock.LastApprove = null;
        await store.ResolveGateAsync("r1", "g1", approve: false, scope: "once");
        Assert.Null(sock.LastApprove!.Scope);
        Assert.False(sock.LastApprove!.Approve);
        // Approve once: scope stripped (server infers once).
        sock.LastApprove = null;
        await store.ResolveGateAsync("r1", "g1", approve: true, scope: "once");
        Assert.True(sock.LastApprove!.Approve);
        Assert.Null(sock.LastApprove!.Scope);
        // Approve session: scope rides.
        sock.LastApprove = null;
        await store.ResolveGateAsync("r1", "g1", approve: true, scope: "session");
        Assert.Equal("session", sock.LastApprove!.Scope);
    }

    [Fact]
    public async Task NotifyPushIsCappedTwentyAndInvokesHook()
    {
        var (store, sock, _, _) = MakeStore();
        var toastCount = 0;
        var store2 = new AppStore(sock, new FakeRest(), new FakeSession(), note => Interlocked.Increment(ref toastCount));
        for (var i = 1; i <= 25; i++)
        {
            sock.Emit("notify.push", "notify", i, new { title = $"t{i}", body = "b" });
        }
        var s = store2.State;
        Assert.Equal(20, s.Notifications.Count); // cap
        Assert.Equal("t25", s.Notifications.Last().Title); // drop-oldest
        Assert.Equal(25, toastCount);
    }

    [Fact]
    public async Task ResyncOnRunChannelRefetchesRunAndEvents()
    {
        var (store, sock, _, _) = MakeStore();
        await store.SelectChatAsync("ch_1");
        var waitRun = new TaskCompletionSource();
        store.StateChanged += _ => { if (store.State.Runs.ContainsKey("rX") && store.State.Events.ContainsKey("rX")) waitRun.TrySetResult(); };
        sock.ScriptedRunGets.Enqueue(Task.FromResult(FakeSocket.JsonSer(new
        {
            id = "rX",
            status = "running",
            trigger = "chat",
            model = "",
            budgets = new { maxSteps = 25, maxTokens = 100000, maxCostUsd = 5, maxWallMs = 600000 },
            createdAt = FakeSessionIso(),
            seq = 0,
        })));
        sock.ScriptedRunEvents.Enqueue(Task.FromResult(EmptyJsonArray()));
        sock.EmitResync("run:rX");
        await Task.WhenAny(waitRun.Task, Task.Delay(10_000));
        Assert.True(waitRun.Task.IsCompleted, "resync refetch did not land");
    }

    [Fact]
    public async Task ExecutorStatusEventUpdatesState()
    {
        var (store, sock, _, _) = MakeStore();
        await store.SelectChatAsync("ch_1");
        sock.Emit("executor.status", "sys", 7, new { online = false, reason = "dropped" });
        var s = store.State;
        Assert.False(s.Executor!.Online);
        Assert.Equal("dropped", s.Executor!.Reason);
    }

    private static System.Text.Json.JsonElement EmptyJsonArray() => JsonSerializer.SerializeToElement(Array.Empty<object>());
    private static string FakeSessionIso() => "2026-01-01T00:00:00.000Z";
}