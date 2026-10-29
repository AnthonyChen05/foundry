using System.Text.Json;
using System.Text.Json.Serialization;

namespace Foundry.Protocol;

/// <summary>
/// One System.Text.Json source-gen context for everything on the wire. Wire keys are
/// camelCase (property-naming policy); unknown inbound members are skipped by default;
/// null-optional members are omitted when writing (DefaultIgnoreCondition WhenWritingNull
/// — matches the Android/socket senders that omit absent optionals).
/// </summary>
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    NumberHandling = JsonNumberHandling.AllowReadingFromString)]
[JsonSerializable(typeof(ReqFrame))]
[JsonSerializable(typeof(ConnectEnvelope))]
[JsonSerializable(typeof(ResumeEntry))]
[JsonSerializable(typeof(ClientInfo))]
[JsonSerializable(typeof(AuthInfo))]
[JsonSerializable(typeof(ConnectResult))]
[JsonSerializable(typeof(ConnectionState))]
[JsonSerializable(typeof(ChatSummary))]
[JsonSerializable(typeof(Message))]
[JsonSerializable(typeof(ContentPart))]
[JsonSerializable(typeof(ToolCall))]
[JsonSerializable(typeof(ToolCallFunction))]
[JsonSerializable(typeof(Model))]
[JsonSerializable(typeof(ModelCaps))]
[JsonSerializable(typeof(Run))]
[JsonSerializable(typeof(RunBudgets))]
[JsonSerializable(typeof(Gate))]
[JsonSerializable(typeof(RunEventItem))]
[JsonSerializable(typeof(FileEntry))]
[JsonSerializable(typeof(ExecutorInfo))]
[JsonSerializable(typeof(TermOpenResult))]
[JsonSerializable(typeof(ChatSendParams))]
[JsonSerializable(typeof(AgentParams))]
[JsonSerializable(typeof(AuthLoginResult))]
[JsonSerializable(typeof(RunApproveParams))]
[JsonSerializable(typeof(RunEventsParams))]
[JsonSerializable(typeof(ChatHistoryParams))]
[JsonSerializable(typeof(TermInputParams))]
[JsonSerializable(typeof(TermResizeParams))]
[JsonSerializable(typeof(FilesListParams))]
[JsonSerializable(typeof(FilesReadResult))]
[JsonSerializable(typeof(FilesWriteParams))]
[JsonSerializable(typeof(FilesPathParams))]
[JsonSerializable(typeof(FilesMkdirParams))]
[JsonSerializable(typeof(FilesRmParams))]
[JsonSerializable(typeof(List<ChatSummary>))]
[JsonSerializable(typeof(List<Message>))]
[JsonSerializable(typeof(List<Model>))]
[JsonSerializable(typeof(List<RunEventItem>))]
[JsonSerializable(typeof(List<FileEntry>))]
[JsonSerializable(typeof(List<Gate>))]
[JsonSerializable(typeof(Dictionary<string, string>))]
[JsonSerializable(typeof(JsonElement))]
public partial class WireJsonContext : JsonSerializerContext
{
}

// ---------------------------------------------------------------------------
// connect-frame params pieces (built once per handshake)
// ---------------------------------------------------------------------------

public sealed record AuthInfo(string Token);

public sealed record ClientInfo(string Kind, string Version);

public sealed record ResumeEntry(string Channel, long LastSeq);

/// <summary>Top-level connect params: {protocol, auth, client, resume?}.</summary>
public sealed record ConnectEnvelope(int Protocol, AuthInfo Auth, ClientInfo Client, IReadOnlyList<ResumeEntry>? Resume);

// ---------------------------------------------------------------------------
// params/result DTOs the socket + store send through frames
// ---------------------------------------------------------------------------

public sealed record ChatSendParams(string ChatId, string Content, string? Model, AgentParams? Agent);

public sealed record AgentParams(bool Enabled, IReadOnlyDictionary<string, string>? ToolPolicy, string? Location);

public sealed record AuthLoginResult(string SessionToken, string ExpiresAt);

public sealed record RunApproveParams(string RunId, string GateId, bool Approve, string? Scope);

public sealed record RunEventsParams(string RunId, long Since);

public sealed record ChatHistoryParams(string ChatId, long? Before, int? Limit);

public sealed record TermInputParams(string TermId, string Data, bool? B64);

public sealed record TermResizeParams(string TermId, int Cols, int Rows);

public sealed record FilesListParams(string? EnvId, string Path);

public sealed record FilesReadResult(string Content, string? B64);

public sealed record FilesWriteParams(string? EnvId, string Path, string Content, bool? B64);

public sealed record FilesPathParams(string? EnvId, string Path);

public sealed record FilesMkdirParams(string? EnvId, string Path, bool? Recursive);

/// <summary>Server default: recursive TRUE for mkdir, FALSE for rm.</summary>
public sealed record FilesRmParams(string? EnvId, string Path, bool? Recursive);

/// <summary>Client-connection state persisted across reconnects (cursors + identity).</summary>
public sealed record ConnectionState(IReadOnlyDictionary<string, long> Cursors);