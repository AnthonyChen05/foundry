using Foundry.Protocol;

namespace Foundry_App.Screens;

/// <summary>
/// A run-timeline row for the chat inspector (Android TimelineScreen Describe parity,
/// 300/400-char caps). Kind discriminates the template (status/usage/tool rows).
/// </summary>
public sealed class TimelineRow
{
    public string Kind { get; init; } = "";
    public string Text { get; init; } = "";
    public bool Live { get; init; }
}

/// <summary>Formats one timeline row from a run-event or live-frame payload.</summary>
public static class TimelineDescribe
{
    /// <summary>Normalize the event-name (live frames: "run.tool_call"; replay rows: "tool_call").</summary>
    private static string KindOf(string type) => type switch
    {
        "tool_call" or "run.tool_call" => "tool_call",
        "tool_result" or "run.tool_result" => "tool_result",
        "usage" or "run.usage" => "usage",
        "gate_request" or "run.gate_request" => "gate",
        "gate_resolved" or "run.gate_resolved" => "gate",
        "status" or "run.status" => "status",
        "delta" or "chat.delta" => "delta",
        "error" => "error",
        _ => "other",
    };

    public static TimelineRow? From(string type, object? payload, bool live)
    {
        var kind = KindOf(type);
        return new TimelineRow
        {
            Kind = kind,
            Live = live,
            Text = DescribeText(kind, payload),
        };
    }

    private static string DescribeText(string kind, object? payload)
    {
        if (payload is not System.Text.Json.JsonElement el || el.ValueKind != System.Text.Json.JsonValueKind.Object)
        {
            return kind;
        }
        switch (kind)
        {
            case "status":
                var status = Str(el, "status");
                var error = Str(el, "error");
                return "▸ " + (status ?? "?") + (error is { Length: > 0 } ? " — " + error : "");
            case "tool_call":
                if (el.TryGetProperty("call", out var call) && call.ValueKind == System.Text.Json.JsonValueKind.Object)
                {
                    var name = Str(call, "name") ?? "?";
                    var args = call.TryGetProperty("args", out var a) ? ArgsText(a) : "";
                    return "⚙ " + name + (args.Length > 0 ? " " + Clip(args, 300) : "");
                }
                return "⚙ tool call";
            case "tool_result":
                var ok = el.TryGetProperty("ok", out var okEl) && okEl.ValueKind == System.Text.Json.JsonValueKind.True;
                var content = el.TryGetProperty("content", out var c) ? ArgsText(c) : "";
                return (ok ? "✓ " : "✗ ") + Clip(content, 400);
            case "usage":
                var pt = el.TryGetProperty("promptTokens", out var p) ? p.GetInt64() : 0;
                var ct = el.TryGetProperty("completionTokens", out var ctEl) ? ctEl.GetInt64() : 0;
                var cost = el.TryGetProperty("costEst", out var costEl) ? costEl.GetDouble() : 0;
                return $"tokens {pt}/{ct} · ${cost}";
            case "gate":
                var g = Str(el, "tool") ?? "?";
                if (el.TryGetProperty("state", out var st)) return "gate " + g + " → " + st.GetString();
                return "gate: " + g + " (asks approval)";
            case "delta":
                return "Δ " + Clip(Str(el, "delta") ?? Str(el, "text") ?? "", 200);
            case "error":
                return "✗ " + Clip(el.ToString(), 200);
            default:
                return kind;
        }
    }

    private static string ArgsText(System.Text.Json.JsonElement el)
    {
        try
        {
            return el.ValueKind == System.Text.Json.JsonValueKind.String
                ? el.GetString() ?? ""
                : el.GetRawText();
        }
        catch
        {
            return "";
        }
    }

    private static string? Str(System.Text.Json.JsonElement el, string key) =>
        el.TryGetProperty(key, out var v) && v.ValueKind == System.Text.Json.JsonValueKind.String ? v.GetString() : null;

    private static string Clip(string s, int n) =>
        s.Length <= n ? s.Replace("\n", " ") : s[..n].Replace("\n", " ") + "…";
}