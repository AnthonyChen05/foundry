using System.Collections.Concurrent;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace Foundry.Tests;

/// <summary>
/// An in-process fake hub speaking the Foundry frame protocol so the socket port can be
/// tested end-to-end without a live core: validates the connect handshake, floods scripted
/// events, and answers (or records) client requests like the real hub would.
/// </summary>
public sealed class FakeHub : IDisposable
{
    private readonly HttpListener _listener = new();
    private readonly List<WebSocket> _conns = [];

    public string Url { get; }
    public string Version { get; } = "1.0.0-test";
    public static readonly int ProtocolVersion = 0;

    /// <summary>The recorded handshake connect params (asserted by tests).</summary>
    public JsonElement? LastConnectParams { get; private set; }

    /// <summary>Completes when a handshake carrying a non-empty resume[] arrives (reconnect path).</summary>
    public TaskCompletionSource<JsonElement> ResumeSeen { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <summary>Token the hub accepts ("correct-token"); anything else → unauthorized res + 1008 close.</summary>
    public string AcceptedToken { get; set; } = "correct-token";

    /// <summary>Scripted per-method responders (payload builders). Unmatched methods → error res.</summary>
    public ConcurrentDictionary<string, Func<JsonElement?, object?>> Responders { get; } = new();

    /// <summary>Received (method, idem, id, params) from client requests.</summary>
    public ConcurrentQueue<(string Method, string? Idem, string Id, JsonElement? Params)> Requests { get; } = new();

    public Func<JsonElement?, object?>? DefaultResponder { get; set; }

    private FakeHub(int port)
    {
        Url = $"http://127.0.0.1:{port}";
    }

    public static FakeHub Start()
    {
        foreach (var attempt in Enumerable.Range(0, 50))
        {
            var port = 18090 + attempt + Random.Shared.Next(0, 5);
            var hub = new FakeHub(port);
            try
            {
                hub._listener.Prefixes.Add($"{hub.Url}/ws/");
                hub._listener.Start();
                return hub;
            }
            catch (HttpListenerException)
            {
                hub.Dispose(false);
            }
        }
        throw new InvalidOperationException("no test port available");
    }

    /// <summary>Arms the listener and fires the pump detached; completes when the WS is
    /// ACCEPTED (not when the pump exhausts the connection). Returns null when the listener
    /// stops first (test teardown) — callers either await it deliberately or discard it;
    /// it must NEVER fault unhandled (that kills the test host).</summary>
    public async Task<WebSocket?> AcceptAsync(CancellationToken ct = default)
    {
        try
        {
            var ctx = await _listener.GetContextAsync().ConfigureAwait(false);
            ct.ThrowIfCancellationRequested();
            var wsCtx = await ctx.AcceptWebSocketAsync(null).ConfigureAwait(false);
            var ws = wsCtx.WebSocket;
            lock (_conns) _conns.Add(ws);
            _ = PumpIncomingAsync(ws, ctx, ct);
            return ws;
        }
        catch
        {
            return null; // listener stopped (teardown) — not an error for discarded accepts
        }
    }

    private async Task PumpIncomingAsync(WebSocket ws, HttpListenerContext ctx, CancellationToken ct)
    {
        // The pump is detached (_ = PumpIncomingAsync): it MUST swallow everything — an
        // unhandled exception on this background task crashes the whole test host.
        try
        {
            await PumpBodyAsync(ws, ctx, ct).ConfigureAwait(false);
        }
        catch
        {
            // aborted/disposed/canceled during teardown — expected in reconnect tests
        }
    }

    private async Task PumpBodyAsync(WebSocket ws, HttpListenerContext ctx, CancellationToken ct)
    {
        // Handshake: first frame must be req connect (mirroring ws_hub.ts first-frame rule).
        var first = await ReadFrameAsync(ws, ct).ConfigureAwait(false);
        if (first is null)
        {
            await ws.CloseAsync(WebSocketCloseStatus.PolicyViolation, "first frame must be connect", ct).ConfigureAwait(false);
            return;
        }
        var (id, method, idem, parameters) = first;
        if (method != "connect")
        {
            await ws.CloseAsync(WebSocketCloseStatus.PolicyViolation, "first frame must be connect", ct).ConfigureAwait(false);
            return;
        }
        LastConnectParams = parameters;
        {
            if (parameters is { ValueKind: JsonValueKind.Object } cp
                && cp.TryGetProperty("resume", out var resumeEl)
                && resumeEl.ValueKind == JsonValueKind.Array
                && resumeEl.GetArrayLength() > 0)
            {
                ResumeSeen.TrySetResult(resumeEl);
            }
        }
        var token = parameters is { ValueKind: JsonValueKind.Object } p
            && p.TryGetProperty("auth", out var auth) && auth.TryGetProperty("token", out var tk)
            && tk.ValueKind == JsonValueKind.String ? tk.GetString() : null;
        if (token != AcceptedToken)
        {
            await SendTextAsync(ws, ResError(id, "unauthorized", "invalid token"), ct).ConfigureAwait(false);
            await ws.CloseAsync(WebSocketCloseStatus.PolicyViolation, "bad token", ct).ConfigureAwait(false);
            return;
        }
        await SendTextAsync(ws, ResOk(id, new
        {
            sessionId = "s_test",
            protocol = ProtocolVersion,
            features = new { methods = Array.Empty<string>(), events = Array.Empty<string>() },
            snapshot = new { activeRuns = Array.Empty<string>(), unread = 0 },
        }), ct).ConfigureAwait(false);

        // Serve subsequent requests until the connection dies.
        while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
        {
            var frame = await ReadFrameAsync(ws, CancellationTokenSource.CreateLinkedTokenSource(ct, new CancellationTokenSource(TimeSpan.FromSeconds(60)).Token).Token).ConfigureAwait(false);
            if (frame is null) break;
            Requests.Enqueue((frame.Method, frame.Idem, frame.Id, frame.Params));
            var responder = Responders.TryGetValue(frame.Method, out var r) ? r : DefaultResponder;
            if (responder is null)
            {
                await SendTextAsync(ws, ResError(frame.Id, "bad_request", $"unknown method: {frame.Method}"), ct).ConfigureAwait(false);
                continue;
            }
            try
            {
                var payload = responder(frame.Params);
                await SendTextAsync(ws, ResOk(frame.Id, payload ?? new { }), ct).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                await SendTextAsync(ws, ResError(frame.Id, "internal", ex.Message), ct).ConfigureAwait(false);
            }
        }
    }

    /// <summary>Server-initiated pushes: flood an event frame to ALL open connections (ws_hub publish).</summary>
    public async Task PublishAsync(string eventName, string channel, long seq, object? payload, CancellationToken ct = default)
    {
        List<WebSocket> snapshot;
        lock (_conns) snapshot = _conns.Where(c => c.State == WebSocketState.Open).ToList();
        foreach (var ws in snapshot)
        {
            await SendTextAsync(ws, Event(eventName, channel, seq, payload), ct).ConfigureAwait(false);
        }
    }

    /// <summary>Hard-close every connection (for reconnect tests). Callers re-accept after.</summary>
    public void DropAll()
    {
        lock (_conns)
        {
            foreach (var ws in _conns)
            {
                if (ws.State == WebSocketState.Open)
                {
                    ws.Abort();
                }
            }
            _conns.Clear();
        }
    }

    public static string Event(string eventName, string channel, long seq, object? payload) =>
        SerializeEvent(eventName, channel, seq, payload);

    private static string SerializeEvent(string eventName, string channel, long seq, object? payload)
    {
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            w.WriteStartObject();
            w.WriteString("type", "event");
            w.WriteString("event", eventName);
            w.WriteString("channel", channel);
            w.WriteNumber("seq", seq);
            if (payload is not null)
            {
                w.WritePropertyName("payload");
                JsonSerializer.Serialize(w, payload, payload.GetType());
            }
            w.WriteEndObject();
        }
        return Encoding.UTF8.GetString(ms.ToArray());
    }

    public static string ResOk(string id, object? payload) => SerializeRes(id, true, payload);

    public static string ResError(string id, string code, string message)
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

    private static string SerializeRes(string id, bool ok, object? payload)
    {
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            w.WriteStartObject();
            w.WriteString("type", "res");
            w.WriteString("id", id);
            w.WriteBoolean("ok", ok);
            if (payload is not null)
            {
                w.WritePropertyName("payload");
                JsonSerializer.Serialize(w, payload, payload.GetType());
            }
            w.WriteEndObject();
        }
        return Encoding.UTF8.GetString(ms.ToArray());
    }

    public record InboundFrame(string Id, string Method, string? Idem, JsonElement? Params);

    private static async Task<InboundFrame?> ReadFrameAsync(WebSocket ws, CancellationToken ct)
    {
        using var ms = new MemoryStream();
        var buffer = new byte[32 * 1024];
        while (true)
        {
            var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct).ConfigureAwait(false);
            if (result.MessageType == WebSocketMessageType.Close) return null;
            ms.Write(buffer, 0, result.Count);
            if (result.EndOfMessage) break;
        }
        if (ms.Length == 0) return null;
        using var doc = JsonDocument.Parse(ms.ToArray());
        var root = doc.RootElement.Clone();
        string? id = null, method = null, idem = null;
        JsonElement? parameters = null;
        if (root.TryGetProperty("id", out var idEl)) id = idEl.ValueKind == JsonValueKind.String ? idEl.GetString() : null;
        if (root.TryGetProperty("method", out var mEl)) method = mEl.GetString();
        if (root.TryGetProperty("idem", out var iEl)) idem = iEl.GetString();
        if (root.TryGetProperty("params", out var pEl)) parameters = pEl;
        var clampedId = id ?? "";
        var clampedMethod = method ?? "";
        return new InboundFrame(clampedId, clampedMethod, idem, parameters);
    }

    private async Task SendTextAsync(WebSocket ws, string text, CancellationToken ct)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        await ws.SendAsync(bytes.AsMemory(), WebSocketMessageType.Text, true, ct).ConfigureAwait(false);
    }

    private void Dispose(bool disposeListener)
    {
        lock (_conns)
        {
            foreach (var ws in _conns)
            {
                try { ws.Dispose(); } catch { /* */ }
            }
            _conns.Clear();
        }
        if (disposeListener)
        {
            try { _listener.Stop(); _listener.Close(); } catch { /* */ }
        }
    }

    public void Dispose()
    {
        GC.SuppressFinalize(this);
        Dispose(true);
    }
}