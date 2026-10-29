using System.Buffers;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;
using Foundry.Protocol;

namespace Foundry.Sdk;

/// <summary>
/// Foundry WS client — 1:1 behavior port of packages/sdk-ts/src/socket.ts and the Android
/// data/FoundrySocket.kt (the shipped reference), with clientKind "windows":
///
/// - First frame MUST be `req connect` with id literally "connect" (the id is RESERVED —
///   an ok:false on it marks auth failure permanent for the token; no normal request may
///   reuse it).
/// - Events flood every ready connection on all channels — no subscribe; clients filter.
/// - Per-channel in-memory cursor map travels in `resume:[{channel,lastSeq}]` (lastSeq −1
///   = full ring; server ring = 500 events/channel; seqs reset on core restart → the
///   server sends sys.resync and the client refetches).
/// - `idem` rides on the frame (never in params) for the IDEMPOTENT_METHODS set.
/// - 60s per-request timeout surfaces as code "capacity", retryable (both references).
/// - Reconnect: exponential 250ms·2^n + jitter(0..250), capped 15s; handshake `unauthorized`
///   is permanent (a fixed token can't recover); deliberate Close suppresses reconnect.
/// - Server→client req frames (executor plane) are answered ok:false "not an executor" —
///   this app's executor is the runner PROCESS, never the app.
/// </summary>
public sealed class FoundrySocket : IFdSocket, IAsyncDisposable
{
    public const string ClientKind = "windows";

    private readonly string _baseUrl;
    private readonly bool _autoReconnect;
    private readonly ConcurrentDictionary<string, long> _cursors = new();
    private readonly ConcurrentDictionary<string, TaskCompletionSource<ResFrame>> _pending = new();
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private readonly CancellationTokenSource _lifetime = new();

    private ClientWebSocket? _ws;
    private long _requestId;
    private volatile bool _authFailed;   // sticky: handshake rejected the token — never retry
    private volatile bool _deliberatelyClosed;

    /// <summary>Zero-arg WS methods still send a params OBJECT (the hub schema-checks an
    /// object, not absent).</summary>
    private static readonly object EmptyParams = new { };

    /// <summary>Assign BEFORE ConnectAsync — the store wires these first (IFdSocket events).</summary>
    public event Action<string, string, long, JsonElement?>? OnEvent;
    public event Action<string>? OnResync;
    public event Action<string>? OnStatus;

    /// <summary>Swap tokens before a reconnect (sdk-ts client.setToken pattern): the next
    /// handshake uses it; the current connection is unaffected.</summary>
    public void SetToken(string? token) => Token = token;

    /// <summary>Sticky auth failure — the store drops the token and returns to login.</summary>
    public bool AuthFailed => _authFailed;

    /// <summary>Cursor seen for a channel (test/parity introspection; −1 = none).</summary>
    public long CursorOf(string channel) => _cursors.TryGetValue(channel, out var v) ? v : -1;

    /// <summary>Code returned by the LAST handshake failure ("" if none; introspection).</summary>
    public string LastHandshakeErrorCode { get; private set; } = "";

    /// <summary>Last status raised via OnStatus (ConnStatus values; test/parity introspection).</summary>
    public string LastStatus { get; private set; } = "";

    private void RaiseStatus(string status)
    {
        LastStatus = status;
        OnStatus?.Invoke(status);
    }

    public string? Token { get; private set; }

    public FoundrySocket(string baseUrl, string? token, bool autoReconnect = true, string? clientVersion = null)
    {
        _baseUrl = BaseUrlNormalizer.StripTrailingSlash(baseUrl);
        Token = token;
        _autoReconnect = autoReconnect;
        Version = clientVersion ?? "0.1.0";
    }

    public string Version { get; }

    private string WsUrl
    {
        get
        {
            var b = _baseUrl;
            if (b.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) b = "wss://" + b["https://".Length..];
            else if (b.StartsWith("http://", StringComparison.OrdinalIgnoreCase)) b = "ws://" + b["http://".Length..];
            if (!b.EndsWith("/ws", StringComparison.Ordinal)) b += "/ws";
            return b;
        }
    }

    // ------------------------------------------------------------------
    // lifecycle
    // ------------------------------------------------------------------

    /// <summary>One connect + handshake. Throws FoundryError on failure. The reconnect loop
    /// engages only after this first ConnectAsync succeeds (caller then calls the store,
    /// which starts the loop).</summary>
    public async Task<ConnectResult> ConnectAsync(CancellationToken ct)
    {
        var ws = new ClientWebSocket
        {
            Options = { KeepAliveInterval = TimeSpan.FromSeconds(20) },
        };
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        await ws.ConnectAsync(new Uri(WsUrl), timeout.Token).ConfigureAwait(false);

        var frame = FrameJson.WriteReq("connect", "connect", BuildConnectParams(resume: true), idem: null);
        await SendTextAsync(ws, frame, CancellationToken.None).ConfigureAwait(false);

        var res = await ReceiveOneAsync(ws, "connect", CancellationToken.None).ConfigureAwait(false);
        if (!res.Ok)
        {
            // The id "connect" ok:false is the sticky auth-fail signal for the whole socket.
            // The server hard-closes (1008) on bad token/protocol — nothing to reply to; dispose.
            if (res.Error is { } e) LastHandshakeErrorCode = e.Code;
            if (res.Error?.Code == ErrorCodes.Unauthorized) _authFailed = true;
            ws.Dispose();
            throw new FoundryError(
                res.Error?.Code ?? ErrorCodes.Internal,
                res.Error?.Message ?? "connect failed",
                res.Error?.Retryable ?? false);
        }
        var result = res.Payload is { ValueKind: JsonValueKind.Object } p
            ? p.ReadWire(WireJsonContext.Default.ConnectResult)
              ?? throw new FoundryError(ErrorCodes.Internal, "bad connect payload")
            : throw new FoundryError(ErrorCodes.Internal, "bad connect payload");
        _ws = ws;
        StartReceiveLoop(ws);
        return result;
    }

    /// <summary>Background reconnect loop (start after the first successful ConnectAsync).</summary>
    public void StartReconnectLoop() => StartReconnectLoop(0);

    private void StartReconnectLoop(int startAttempt)
    {
        _ = Task.Run(async () =>
        {
            var attempt = startAttempt;
            var rng = Random.Shared;
            while (!_lifetime.IsCancellationRequested
                   && !_deliberatelyClosed
                   && !_authFailed
                   && _autoReconnect)
            {
                RaiseStatus(ConnStatus.Reconnecting);
            var backoff = Math.Min(250L * (1L << Math.Min(attempt, 16)) + rng.Next(0, 250), 15_000L);
                try
                {
                    await Task.Delay(TimeSpan.FromMilliseconds(backoff), _lifetime.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) { break; }
                try
                {
                    var ws = new ClientWebSocket
                    {
                        Options = { KeepAliveInterval = TimeSpan.FromSeconds(20) },
                    };
                    // Per-attempt connect timeout: an upgrade never answered must not park
                    // the loop forever (the lifetime token alone would).
                    using var attemptCts = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
                    attemptCts.CancelAfter(TimeSpan.FromSeconds(10));
                    await ws.ConnectAsync(new Uri(WsUrl), attemptCts.Token).ConfigureAwait(false);
                    var frame = FrameJson.WriteReq("connect", "connect", BuildConnectParams(resume: true), idem: null);
                    await SendTextAsync(ws, frame, CancellationToken.None).ConfigureAwait(false);
                    var res = await ReceiveOneAsync(ws, "connect", CancellationToken.None).ConfigureAwait(false);
                    if (!res.Ok)
                    {
                        if (res.Error?.Code == ErrorCodes.Unauthorized)
                        {
                            _authFailed = true; // permanent for this token
                            ws.Dispose();
                            RaiseStatus(ConnStatus.Closed);
                            break;
                        }
                        ws.Dispose();
                        attempt++;
                        continue;
                    }
                    _ws = ws;
                    attempt = 0;
                    RaiseStatus(ConnStatus.Open);
                    StartReceiveLoop(ws);
                }
                catch (OperationCanceledException) { break; }
                catch (Exception)
                {
                    attempt++;
                }
            }
        }, CancellationToken.None);
    }

    /// <summary>Deliberate close: no reconnect; pending requests fail with code "internal".</summary>
    public async Task CloseAsync()
    {
        _deliberatelyClosed = true;
        FailAllPending("socket closed", ErrorCodes.Internal);
        _lifetime.Cancel();
        var ws = Interlocked.Exchange(ref _ws, null);
        if (ws is not null)
        {
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "client closing", cts.Token).ConfigureAwait(false);
            }
            catch { /* already gone */ }
            ws.Dispose();
        }
        RaiseStatus(ConnStatus.Closed);
    }

    public ValueTask DisposeAsync()
    {
        _deliberatelyClosed = true;
        FailAllPending("socket disposed", ErrorCodes.Internal);
        _lifetime.Cancel();
        var ws = Interlocked.Exchange(ref _ws, null);
        ws?.Dispose();
        // NOTE: _sendLock is deliberately NOT disposed — background loops may still hold/
        // wait on it during teardown; a disposed semaphore in flight = unhandled exceptions
        // that crash the test host. The object is process-lifetime in practice.
        return ValueTask.CompletedTask;
    }

    // ------------------------------------------------------------------
    // requests
    // ------------------------------------------------------------------

    public async Task<JsonElement> RequestAsync(string method, object? parameters = null, string? idem = null)
    {
        var ws = _ws ?? throw new FoundryError(ErrorCodes.Internal, "socket not connected");
        var id = NextRequestId();
        var frame = FrameJson.WriteReq(id, method, parameters, idem);
        var tcs = new TaskCompletionSource<ResFrame>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[id] = tcs;
        try
        {
            // A dead-but-replaced socket can throw here; remove the pending entry either way.
            await SendTextAsync(ws, frame, CancellationToken.None).ConfigureAwait(false);
            var timeoutTask = Task.Delay(TimeSpan.FromSeconds(60));
            var completed = await Task.WhenAny(tcs.Task, timeoutTask).ConfigureAwait(false);
            if (completed != tcs.Task)
            {
                _pending.TryRemove(id, out _);
                // Both reference clients surface the 60s timeout as code "capacity", retryable.
                throw new FoundryError(ErrorCodes.Capacity, $"timeout waiting for {method} response", retryable: true);
            }
            var res = tcs.Task.Result;
            if (!res.Ok)
            {
                var err = res.Error ?? new ProtocolWireError(ErrorCodes.Internal, "request failed without error payload", null);
                throw new FoundryError(err.Code, err.Message, err.Retryable ?? false);
            }
            return res.Payload ?? throw new FoundryError(ErrorCodes.Internal, $"no payload for {method}");
        }
        catch (WebSocketException ex)
        {
            _pending.TryRemove(id, out _);
            throw new FoundryError(ErrorCodes.Internal, $"socket error: {ex.Message}", retryable: true);
        }
        catch (Exception)
        {
            _pending.TryRemove(id, out _);
            throw;
        }
    }

    private string NextRequestId()
    {
        var n = Interlocked.Increment(ref _requestId);
        return ToBase36(n);
    }

    private static string ToBase36(long n)
    {
        const string digits = "0123456789abcdefghijklmnopqrstuvwxyz";
        if (n == 0) return "0";
        var sb = new StringBuilder(12);
        while (n > 0)
        {
            sb.Insert(0, digits[(int)(n % 36)]);
            n /= 36;
        }
        return sb.ToString();
    }

    // ------------------------------------------------------------------
    // typed client-plane methods (the Android / web store surface)
    // ------------------------------------------------------------------

    public Task<JsonElement> Health() => RequestAsync("sys.health", EmptyParams);
    public Task<List<Model>> Models() => RequestAsync("sys.models", EmptyParams).DeserializeList(WireJsonContext.Default.ListModel);
    public Task<List<ChatSummary>> ChatList() => RequestAsync("chat.list", EmptyParams).DeserializeList(WireJsonContext.Default.ListChatSummary);
    public async Task<ChatSummary> ChatCreate(string? title = null, string? model = null) =>
        (await RequestAsync("chat.create", new { title, model }).ConfigureAwait(false))
            .ReadWire(WireJsonContext.Default.ChatSummary)
        ?? throw new FoundryError(ErrorCodes.Internal, "bad chat.create payload");
    public Task<List<Message>> ChatHistory(string chatId) =>
        RequestAsync("chat.history", new ChatHistoryParams(chatId, null, null)).DeserializeList(WireJsonContext.Default.ListMessage);
    public async Task<(string RunId, string ConversationId)> ChatSend(
        string chatId, string content, string? model, AgentParams? agent, string idem)
    {
        var payload = await RequestAsync("chat.send", new ChatSendParams(chatId, content, model, agent), idem).ConfigureAwait(false);
        var runId = payload.TryGetProperty("runId", out var rid) ? rid.GetString() ?? "" : "";
        var conv = payload.TryGetProperty("conversationId", out var cid) ? cid.GetString() ?? "" : "";
        return (runId, conv);
    }
    public async Task<Run> RunGet(string runId) =>
        (await RequestAsync("run.get", new { runId }).ConfigureAwait(false)).ReadWire(WireJsonContext.Default.Run)
        ?? throw new FoundryError(ErrorCodes.Internal, "bad run.get payload");
    public Task<List<RunEventItem>> RunEvents(string runId) =>
        RequestAsync("run.events", new RunEventsParams(runId, 0)).DeserializeList(WireJsonContext.Default.ListRunEventItem);
    public Task<JsonElement> RunCancel(string runId, string idem) => RequestAsync("run.cancel", new { runId }, idem);
    public async Task<Gate> RunApprove(RunApproveParams p, string idem) =>
        (await RequestAsync("run.approve", p, idem).ConfigureAwait(false)).ReadWire(WireJsonContext.Default.Gate)
        ?? throw new FoundryError(ErrorCodes.Internal, "bad run.approve payload");
    public async Task<TermOpenResult> TermOpen(string? envId, string idem)
    {
        var payload = await RequestAsync("term.open", envId is null ? EmptyParams : new { envId }, idem).ConfigureAwait(false);
        return payload.ReadWire(WireJsonContext.Default.TermOpenResult)
            ?? throw new FoundryError(ErrorCodes.Internal, "bad term.open payload");
    }
    public Task<JsonElement> TermInput(string termId, string data, bool? b64, string idem) =>
        RequestAsync("term.input", new TermInputParams(termId, data, b64), idem);
    public Task<JsonElement> TermResize(string termId, int cols, int rows, string idem) =>
        RequestAsync("term.resize", new TermResizeParams(termId, cols, rows), idem);
    public Task<JsonElement> TermClose(string termId, string idem) => RequestAsync("term.close", new { termId }, idem);
    public Task<List<FileEntry>> FilesList(string path, string? envId) =>
        RequestAsync("files.list", new FilesListParams(envId, path)).DeserializeList(WireJsonContext.Default.ListFileEntry);
    public async Task<FilesReadResult> FilesRead(string path, string? envId) =>
        (await RequestAsync("files.read", new FilesPathParams(envId, path)).ConfigureAwait(false))
            .ReadWire(WireJsonContext.Default.FilesReadResult)
        ?? throw new FoundryError(ErrorCodes.Internal, "bad files.read payload");
    public Task<JsonElement> FilesWrite(string path, string content, bool? b64, string? envId, string idem) =>
        RequestAsync("files.write", new FilesWriteParams(envId, path, content, b64), idem);
    public Task<JsonElement> FilesMkdir(string path, bool? recursive, string? envId, string idem) =>
        RequestAsync("files.mkdir", new FilesMkdirParams(envId, path, recursive), idem);
    public Task<JsonElement> FilesRm(string path, bool? recursive, string? envId, string idem) =>
        RequestAsync("files.rm", new FilesRmParams(envId, path, recursive), idem);
    public async Task<FileEntry> FilesStat(string path, string? envId) =>
        (await RequestAsync("files.stat", new FilesPathParams(envId, path)).ConfigureAwait(false))
            .ReadWire(WireJsonContext.Default.FileEntry)
        ?? throw new FoundryError(ErrorCodes.Internal, "bad files.stat payload");
    public async Task<ExecutorInfo> ExecStatus()
    {
        var payload = await RequestAsync("exec.status", EmptyParams).ConfigureAwait(false);
        return payload.ReadWire(WireJsonContext.Default.ExecutorInfo) ?? new ExecutorInfo(false, null, null, null, null, null);
    }
    public async Task<AuthLoginResult> AuthLogin(string username, string password)
    {
        var payload = await RequestAsync("auth.login", new { username, password }).ConfigureAwait(false);
        return payload.ReadWire(WireJsonContext.Default.AuthLoginResult)
            ?? throw new FoundryError(ErrorCodes.Internal, "bad auth.login payload");
    }

    // ------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------

    private ConnectEnvelope BuildConnectParams(bool resume)
    {
        var resumeEntries = resume && !_cursors.IsEmpty
            ? _cursors.Select(kv => new ResumeEntry(kv.Key, kv.Value)).OrderBy(e => e.Channel, StringComparer.Ordinal).ToList()
            : [];
        return new ConnectEnvelope(
            ProtocolVersion.Current,
            new AuthInfo(Token ?? ""),
            new ClientInfo(ClientKind, Version),
            resumeEntries.Count > 0 ? resumeEntries : null);
    }

    private void StartReceiveLoop(ClientWebSocket ws) => _ = Task.Run(() => ReceiveLoopAsync(ws, _lifetime.Token));

    private async Task ReceiveLoopAsync(ClientWebSocket ws, CancellationToken ct)
    {
        var pool = ArrayPool<byte>.Shared;
        byte[] scratch = pool.Rent(32 * 1024);
        try
        {
            while (!ct.IsCancellationRequested && ws.State == WebSocketState.Open)
            {
                using var ms = new MemoryStream();
                var endOfMessage = false;
                while (!endOfMessage)
                {
                    var result = await ws.ReceiveAsync(new ArraySegment<byte>(scratch), ct).ConfigureAwait(false);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        HandleServerCloseAsync(ws);
                        return;
                    }
                    ms.Write(scratch, 0, result.Count);
                    endOfMessage = result.EndOfMessage;
                }
                if (ms.Length == 0) continue;
                HandleFrame(Encoding.UTF8.GetString(ms.ToArray(), 0, (int)ms.Length));
            }
            HandleServerCloseAsync(ws);
        }
        catch (OperationCanceledException)
        {
            // teardown cancel
        }
        catch (Exception) when (_deliberatelyClosed || _lifetime.IsCancellationRequested)
        {
            // teardown
        }
        catch (Exception)
        {
            HandleServerCloseAsync(ws);
        }
        finally
        {
            pool.Return(scratch);
        }
    }

    /// <summary>The socket dropped: fail pending requests, then hand off to the reconnect
    /// loop (or report closed when reconnect is off/permanent). Only acts if this ws is
    /// still the current one.</summary>
    private void HandleServerCloseAsync(ClientWebSocket ws)
    {
        if (Interlocked.CompareExchange(ref _ws, null, ws) != ws) return;
        FailAllPending("connection lost", ErrorCodes.Internal);
        try { ws.Dispose(); } catch { /* gone */ }
        if (_authFailed || _deliberatelyClosed || !_autoReconnect || _lifetime.IsCancellationRequested)
        {
            RaiseStatus(ConnStatus.Closed);
            return;
        }
        StartReconnectLoop();
    }

    private void HandleFrame(string text)
    {
        var parsed = Frames.Parse(text);
        if (parsed is not { Ok: true } || parsed.Value.Frame is not { } frame) return;
        switch (frame)
        {
            case ResFrame res:
                if (res.Id == "connect")
                {
                    // Handshake res: the caller's ReceiveOneAsync registered "connect" (or
                    // has already timed out and removed it — harmless no-op then).
                    if (_pending.TryGetValue(res.Id, out var connectTcs)) connectTcs.TrySetResult(res);
                }
                else if (_pending.TryRemove(res.Id, out var tcs))
                {
                    tcs.TrySetResult(res);
                }
                break;
            case EventFrame ev:
                if (ev.Seq > 0)
                {
                    _cursors[ev.Channel] = ev.Seq; // seen seq — updated on every event incl. replay
                }
                if (ev.Event == "sys.resync")
                {
                    OnResync?.Invoke(ev.Channel);
                }
                OnEvent?.Invoke(ev.Event, ev.Channel, ev.Seq, ev.Payload);
                break;
            case ServerRequestFrame req:
                // This app is never an executor — mirror Android's reply.
                _ = Task.Run(async () =>
                {
                    var w = _ws;
                    if (w is { State: WebSocketState.Open })
                    {
                        try
                        {
                            await SendTextAsync(w, FrameJson.WriteResError(req.Id, ErrorCodes.Internal, "receiver is not an executor"), CancellationToken.None).ConfigureAwait(false);
                        }
                        catch { /* conn is going away; harmless */ }
                    }
                });
                break;
        }
    }

    private void FailAllPending(string message, string code)
    {
        foreach (var (id, tcs) in _pending)
        {
            if (_pending.TryRemove(id, out _))
            {
                tcs.TrySetResult(new ResFrame(id, false, null, new ProtocolWireError(code, message, true)));
            }
        }
    }

    private async Task SendTextAsync(WebSocket ws, string text, CancellationToken ct)
    {
        await _sendLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var bytes = Encoding.UTF8.GetBytes(text);
            await ws.SendAsync(bytes.AsMemory(), WebSocketMessageType.Text, endOfMessage: true, ct).ConfigureAwait(false);
        }
        finally
        {
            _sendLock.Release();
        }
    }

    /// <summary>Handshake-only read: accumulate frames until the res with our id arrives
    /// (other frames during handshake are handled by HandleFrame normally).</summary>
    private async Task<ResFrame> ReceiveOneAsync(WebSocket ws, string id, CancellationToken ct)
    {
        var tcs = new TaskCompletionSource<ResFrame>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[id] = tcs;
        var buffer = new byte[64 * 1024];
        try
        {
            while (!tcs.Task.IsCompleted && !ct.IsCancellationRequested)
            {
                using var ms = new MemoryStream();
                var endOfMessage = false;
                while (!endOfMessage)
                {
                    var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct).ConfigureAwait(false);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        throw new WebSocketException("closed during handshake");
                    }
                    ms.Write(buffer, 0, result.Count);
                    endOfMessage = result.EndOfMessage;
                }
                if (ms.Length == 0) continue;
                HandleFrame(Encoding.UTF8.GetString(ms.ToArray(), 0, (int)ms.Length));
            }
        }
        finally
        {
            _pending.TryRemove(id, out _); // remove the temporary handshake registration
        }
        if (!tcs.Task.IsCompleted) throw new OperationCanceledException(ct);
        return tcs.Task.Result;
    }
}

// --------------------------------------------------------------------------
// small shared helpers
// --------------------------------------------------------------------------

public static class ConnStatus
{
    public const string Offline = "offline";
    public const string Connecting = "connecting";
    public const string Open = "open";
    public const string Reconnecting = "reconnecting";
    public const string Closed = "closed";
}

public static class BaseUrlNormalizer
{
    /// <summary>Trim + strip ALL trailing slashes (protocol wants base w/o trailing /).</summary>
    public static string StripTrailingSlash(string url) => url.Trim().TrimEnd('/');

    /// <summary>Login-screen normalization (Android AppStore.kt:184-187): prepend http:// when
    /// the scheme is missing; https:// passes through; trailing slashes stripped so the
    /// socket/REST builders can append paths blindly.</summary>
    public static string FromLoginInput(string input)
    {
        var trimmed = input.Trim().TrimEnd('/');
        if (trimmed.Length == 0) return trimmed;
        return trimmed.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? trimmed : "http://" + trimmed;
    }
}

/// <summary>
/// Reflection-based wire options for RUNTIME-typed values (anonymous params/bodies the
/// source-gen context can't see): same policies as the context (camelCase, omit nulls).
/// </summary>
public static class WireRuntime
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };
}

/// <summary>Frame JSON writers (exact wire shapes; idem at FRAME level, never params).</summary>
public static class FrameJson
{
    /// <summary>
    /// Request params serialize here with <see cref="WireRuntime.Options"/> (the source-gen
    /// context cannot carry runtime-typed values); param objects are tiny and this is not
    /// hot-path sensitive.
    /// </summary>
    private static readonly JsonSerializerOptions ParamOptions = WireRuntime.Options;

    public static string WriteReq(string id, string method, object? parameters, string? idem)
    {
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            w.WriteStartObject();
            w.WriteString("type", "req");
            w.WriteString("id", id);
            w.WriteString("method", method);
            if (parameters is not null)
            {
                w.WritePropertyName("params");
                JsonSerializer.Serialize(w, parameters, parameters.GetType(), ParamOptions);
            }
            if (idem is not null)
            {
                w.WriteString("idem", idem);
            }
            w.WriteEndObject();
        }
        return Encoding.UTF8.GetString(ms.ToArray());
    }

    public static string WriteResOk(string id, object? payload)
    {
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            w.WriteStartObject();
            w.WriteString("type", "res");
            w.WriteString("id", id);
            w.WriteBoolean("ok", true);
            if (payload is not null)
            {
                w.WritePropertyName("payload");
                JsonSerializer.Serialize(w, payload, payload.GetType(), ParamOptions);
            }
            w.WriteEndObject();
        }
        return Encoding.UTF8.GetString(ms.ToArray());
    }

    public static string WriteResError(string id, string code, string message)
    {
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            w.WriteStartObject();
            w.WriteString("type", "res");
            w.WriteString("id", id);
            w.WriteBoolean("ok", false);
            w.WriteStartObject("error");
            w.WriteString("code", code);
            w.WriteString("message", message);
            w.WriteEndObject();
            w.WriteEndObject();
        }
        return Encoding.UTF8.GetString(ms.ToArray());
    }
}

public static class JsonElementExtensions
{
    /// <summary>Chained read via the source-gen context (System.Text.Json offers no such
    /// extension on JsonElement — this Sdk-side helper keeps the typed call sites tidy).</summary>
    public static T? ReadWire<T>(this JsonElement el, JsonTypeInfo<T> typeInfo) =>
        el.ValueKind is JsonValueKind.Object or JsonValueKind.Array or JsonValueKind.String or JsonValueKind.Number
            ? JsonSerializer.Deserialize(el.GetRawText(), typeInfo)
            : default;

    public static async Task<List<T>> DeserializeList<T>(this Task<JsonElement> task, JsonTypeInfo<List<T>> typeInfo)
    {
        var payload = await task.ConfigureAwait(false);
        return payload.ReadWire(typeInfo) ?? [];
    }
}