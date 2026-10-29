using System.Text.Json;
using Foundry.Protocol;

namespace Foundry.Sdk;

/// <summary>
/// Transport seams the store programs against — FoundrySocket implements IFdSocket
/// (raising its events on its own reader thread; the store marshals), FoundryRest
/// implements IFdRest. Test fakes implement the same shapes.
/// </summary>
public interface IFdSocket
{
    string? Token { get; }
    void SetToken(string? token);
    bool AuthFailed { get; }
    event Action<string, string, long, JsonElement?> OnEvent;
    event Action<string> OnResync;
    event Action<string> OnStatus;
    Task<ConnectResult> ConnectAsync(CancellationToken ct);
    void StartReconnectLoop();
    Task CloseAsync();

    Task<List<Protocol.Model>> Models();
    Task<List<Protocol.ChatSummary>> ChatList();
    Task<Protocol.ChatSummary> ChatCreate(string? title, string? model);
    Task<List<Protocol.Message>> ChatHistory(string chatId);
    Task<(string RunId, string ConversationId)> ChatSend(string chatId, string content, string? model, AgentParams? agent, string idem);
    Task<Protocol.Run> RunGet(string runId);
    Task<List<Protocol.RunEventItem>> RunEvents(string runId);
    Task<JsonElement> RunCancel(string runId, string idem);
    Task<Protocol.Gate> RunApprove(RunApproveParams p, string idem);
    Task<Protocol.TermOpenResult> TermOpen(string? envId, string idem);
    Task<JsonElement> TermInput(string termId, string data, bool? b64, string idem);
    Task<JsonElement> TermResize(string termId, int cols, int rows, string idem);
    Task<JsonElement> TermClose(string termId, string idem);
    Task<List<Protocol.FileEntry>> FilesList(string path, string? envId);
    Task<FilesReadResult> FilesRead(string path, string? envId);
    Task<JsonElement> FilesWrite(string path, string content, bool? b64, string? envId, string idem);
    Task<JsonElement> FilesMkdir(string path, bool? recursive, string? envId, string idem);
    Task<JsonElement> FilesRm(string path, bool? recursive, string? envId, string idem);
    Task<Protocol.FileEntry> FilesStat(string path, string? envId);
    Task<ExecutorInfo> ExecStatus();
    Task<AuthLoginResult> AuthLogin(string username, string password);
}

public interface IFdRest
{
    string? Token { get; set; }
    Task<AuthLoginResult> Login(string username, string password);
    Task ChangePassword(string currentPassword, string newPassword);
    Task<(string PushRunId, string CloudEnvId)> PushChat(string chatId);
    Task<List<FoundryRest.ProviderRow>> ListProviders();
    Task<(string Id, IReadOnlyList<string> Models, bool? Pulled, string? PullError)> UpsertProvider(
        string? id, string kind, string baseUrl, string? apiKey, IReadOnlyList<string>? models);
    Task DeleteProvider(string id);
}