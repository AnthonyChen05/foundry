using System.Text.Json;

namespace Foundry.Protocol;

/// <summary>
/// Protocol error codes (docs/protocol.md §1.4; packages/protocol/src/errors.ts).
/// The client-side 60s request timeout surfaces as "capacity" with retryable=true
/// (both reference clients do this).
/// </summary>
public static class ErrorCodes
{
    public const string BadRequest = "bad_request";
    public const string Unauthorized = "unauthorized";
    public const string NotFound = "not_found";
    public const string Denied = "denied";
    public const string GateTimeout = "gate_timeout";
    public const string ProviderError = "provider_error";
    public const string Capacity = "capacity";
    public const string Internal = "internal";
}

/// <summary>Normalized client-side error (SDK errors.ts FoundryError port).</summary>
public sealed class FoundryError : Exception
{
    public string Code { get; }
    public bool Retryable { get; }

    public FoundryError(string code, string message, bool retryable = false)
        : base(message)
    {
        Code = code;
        Retryable = retryable;
    }

    public bool IsAuthFailure =>
        Code == ErrorCodes.Unauthorized || Code == "authentication_error";
}

// ---------------------------------------------------------------------------
// frames — JSON text frames: req / res / event (docs/protocol.md §1.1)
// ---------------------------------------------------------------------------

public sealed record ReqFrame(string Id, string Method, JsonElement? Params, string? Idem);

public sealed record ResFrame(string Id, bool Ok, JsonElement? Payload, ProtocolWireError? Error);

public sealed record ProtocolWireError(string Code, string Message, bool? Retryable);

public sealed record EventFrame(string Event, string Channel, long Seq, JsonElement? Payload);

/// <summary>Channels: chat:{id} | run:{id} | term:{id} | sys | notify.</summary>
public static class Channels
{
    public const string Sys = "sys";
    public const string Notify = "notify";

    public static string Chat(string chatId) => $"chat:{chatId}";
    public static string Run(string runId) => $"run:{runId}";
    public static string Term(string termId) => $"term:{termId}";

    /// <summary>chat:{id} → id; anything else "".</summary>
    public static string ChatId(string channel) => IdOf(channel, "chat:");
    /// <summary>run:{id} → id; anything else "".</summary>
    public static string RunId(string channel) => IdOf(channel, "run:");
    public static string TermId(string channel) => IdOf(channel, "term:");

    private static string IdOf(string channel, string prefix) =>
        channel.StartsWith(prefix, StringComparison.Ordinal) ? channel[prefix.Length..] : "";
}

/// <summary>
/// Frame parser (Android core/Frames.kt port). Inbound frames: res (correlates a pending
/// request), event, or req (server→client request — this app is never an executor, so the
/// socket answers those ok:false internally; the API still surfaces them).
/// Garbage/unknown frames are IGNORED silently per protocol (server ignores garbage too).
/// </summary>
public static class Frames
{
    public static readonly string IdempotentMethods =
        "chat.send,run.cancel,run.approve,term.open,term.input,term.resize,term.close,files.write,files.mkdir,files.rm";

    public static bool RequiresIdem(string method) =>
        IdempotentMethods.Split(',').Contains(method);

    public static (object Frame, bool Ok)? Parse(string json)
    {
        JsonElement el;
        try
        {
            using var doc = JsonDocument.Parse(json);
            el = doc.RootElement.Clone();
        }
        catch
        {
            return null; // garbage JSON: ignored silently (§1.2)
        }
        if (el.ValueKind != JsonValueKind.Object
            || !el.TryGetProperty("type", out var typeEl)
            || typeEl.ValueKind != JsonValueKind.String)
        {
            return null;
        }
        try
        {
            switch (typeEl.GetString())
            {
                case "res":
                    return (new ResFrame(
                        Str(el, "id") ?? "",
                        Bool(el, "ok") ?? false,
                        Maybe(el, "payload"),
                        el.TryGetProperty("error", out var err) && err.ValueKind == JsonValueKind.Object
                            ? new ProtocolWireError(
                                Str(err, "code") ?? ErrorCodes.Internal,
                                Str(err, "message") ?? "",
                                err.TryGetProperty("retryable", out var r) && r.ValueKind == JsonValueKind.True)
                            : null), true);
                case "event":
                    return (new EventFrame(
                        Str(el, "event") ?? "",
                        Str(el, "channel") ?? "",
                        Num(el, "seq") ?? 0,
                        Maybe(el, "payload")), true);
                case "req":
                    return (new ServerRequestFrame(
                        Str(el, "id") ?? "",
                        Str(el, "method") ?? "",
                        Maybe(el, "params")), true);
                default:
                    return null;
            }
        }
        catch
        {
            return null;
        }
    }

    private static JsonElement? Maybe(JsonElement el, string key) =>
        el.TryGetProperty(key, out var v) ? v : null;

    private static string? Str(JsonElement el, string key) =>
        el.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static bool? Bool(JsonElement el, string key) =>
        el.TryGetProperty(key, out var v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? v.GetBoolean()
            : null;

    private static long? Num(JsonElement el, string key) =>
        el.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n) ? n : null;
}

/// <summary>Server→client req frame (executor plane). This app answers ok:false.</summary>
public sealed record ServerRequestFrame(string Id, string Method, JsonElement? Params);

/// <summary>
/// Lenient gate parsing (payloads VARY by frame — see the inventory): the gate payload's
/// optional members are all tolerated; <paramref name="openState"/> injects state:"open"
/// for run.gate_request rows (flat Gate minus state — open by definition).
/// </summary>
public static class GateParsing
{
    public static Gate? Parse(JsonElement? payload, bool openState)
    {
        if (payload is not { ValueKind: JsonValueKind.Object } p) return null;
        var gate = p.Deserialize(WireJsonContext.Default.Gate);
        if (gate is null) return null;
        return openState ? gate with { State = GateStates.Open } : gate;
    }
}