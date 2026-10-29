namespace Foundry.Protocol;

using System.Text;
using System.Text.Json;

/// <summary>
/// Server-authoritative wire shapes (docs/protocol.md §3 — normative), ported from
/// packages/protocol/src/shapes.ts. Timestamps are ISO 8601 strings except where noted.
/// Message content is canonical OpenAI: string or ContentPart[]; tool_calls arguments
/// are JSON-encoded strings (not objects) — a porting gotcha from the protocol inventory.
/// Parsed leniently: unknown wire fields are skipped (default System.Text.Json behavior),
/// matching the Android client's ignoreUnknownKeys stance.
/// </summary>

public static class ProtocolVersion
{
    public const int Current = 0;
}

public static class RunStatuses
{
    public const string Queued = "queued";
    public const string Running = "running";
    public const string WaitingApproval = "waiting_approval";
    public const string Done = "done";
    public const string Failed = "failed";
    public const string Cancelled = "cancelled";
    public const string Timeout = "timeout";
}

public static class RunTriggers
{
    public const string Chat = "chat";
    public const string Schedule = "schedule";
    public const string Webhook = "webhook";
    public const string Manual = "manual";
    public const string Sandbox = "sandbox";
}

/// <summary>Agent step budgets; server defaults {25, 100000, 5, 600000}.</summary>
public sealed record RunBudgets(int MaxSteps, int MaxTokens, double MaxCostUsd, int MaxWallMs);

public sealed record ToolCall(string Id, string Type, ToolCallFunction Function);

public sealed record ToolCallFunction(string Name, string Arguments);

/// <summary>Multimodal content parts (text / image URLs), pass-through form of user content.</summary>
public sealed record ContentPart(string? Type, string? Text, ContentPartImageUrl? ImageUrl);

public sealed record ContentPartImageUrl(string Url);

/// <summary>
/// Canonical OpenAI message. Content is string or parts array; <c>Data</c> keeps the raw
/// element so the UI can normalize either form (Android's Wire.kt displayText pattern).
/// </summary>
public sealed record Message(string Role, object? Content, string? ToolCallId, string? Name, IReadOnlyList<ToolCall>? ToolCalls)
{
    /// <summary>Flattened display text: string content as-is, parts joined (Android displayText).</summary>
    public string DisplayText => MessageText.Flatten(Content);
}

public static class MessageText
{
    /// <summary>Flatten string-or-parts content the way both reference clients display it.</summary>
    public static string Flatten(object? content)
    {
        return content switch
        {
            null => "",
            string s => s,
            System.Text.Json.JsonElement el => FlattenElement(el),
            _ => content.ToString() ?? "",
        };
    }

    private static string FlattenElement(JsonElement el)
    {
        if (el.ValueKind == JsonValueKind.String)
        {
            return el.GetString() ?? "";
        }
        if (el.ValueKind == JsonValueKind.Array)
        {
            // parts: [{type:"text", text:"..."} ...] — join their text (web store idiom)
            var sb = new StringBuilder();
            foreach (var part in el.EnumerateArray())
            {
                if (part.ValueKind == JsonValueKind.Object
                    && part.TryGetProperty("text", out var text)
                    && text.ValueKind == JsonValueKind.String)
                {
                    sb.Append(text.GetString());
                }
            }
            return sb.ToString();
        }
        return "";
    }
}

public sealed record Model(string Id, string Object, long Created, string OwnedBy, string? Name, int? Context, ModelCaps? Caps, string? Avatar);

public sealed record ModelCaps(bool? Tools, bool? Vision, bool? Reasoning);

public static class GatePolicies
{
    public const string Ask = "ask";
    public const string Always = "always";
    public const string Session = "session";
    public const string Deny = "deny";
}

public static class GateScopes
{
    public const string Once = "once";
    public const string Session = "session";
    public const string Always = "always";
}

public static class GateStates
{
    public const string Open = "open";
    public const string Approved = "approved";
    public const string Denied = "denied";
    public const string Timeout = "timeout";
}

/// <summary>
/// Approval gate. NOTE the payload variance (porting gotcha): run.gate_request arrives
/// WITHOUT State (open by definition — the store injects "open"); run.approve returns the
/// full row; the timeout auto-deny's gate_resolved omits Scope. All optional accordingly.
/// </summary>
public sealed record Gate(
    string GateId,
    string RunId,
    string Tool,
    object? Args,
    string Policy,
    string? State,
    string? Scope,
    string? ResolvedBy,
    string CreatedAt,
    string? ResolvedAt);

public sealed record Run(
    string Id,
    string? ConversationId,
    string Status,
    string Trigger,
    string Model,
    RunBudgets Budgets,
    string CreatedAt,
    long Seq,
    string? Error,
    string? UserId,
    IReadOnlyList<Gate>? Gates,
    string? EnvId);

public sealed record RunEventItem(long Seq, string Type, object? Payload, string CreatedAt);

public static class RunEventTypes
{
    public const string Status = "status";
    public const string Delta = "delta";
    public const string ToolCall = "tool_call";
    public const string ToolResult = "tool_result";
    public const string GateRequest = "gate_request";
    public const string GateResolved = "gate_resolved";
    public const string Usage = "usage";
    public const string Error = "error";
    public const string RawProviderRequest = "raw_provider_request";
    public const string RawProviderResponse = "raw_provider_response";
}

public sealed record ChatSummary(string Id, string Title, string? Model, string CreatedAt, string UpdatedAt)
{
    /// <summary>ADR-015 execution binding: "local" | "cloud"; absent = default cloud, unbound.</summary>
    public string? Location { get; init; }
    public string? EnvId { get; init; }
}

public sealed record FileEntry(string Path, long Size, string Mtime, bool IsDir);

/// <summary>ExecutorInfo from exec.status / executor.status (ADR-015).</summary>
public sealed record ExecutorInfo(bool Online, string? Name, string? Version, bool? DockerAvailable, string? WorkspaceRoot, string? Reason);

public sealed record TermOpenResult(string TermId, string EnvId, string Replay);

public sealed record ConnectSnapshot(string[] ActiveRuns, int Unread);

public sealed record ConnectFeatures(string[] Methods, string[] Events);

public sealed record ConnectResult(string SessionId, int Protocol, ConnectFeatures Features, ConnectSnapshot Snapshot);