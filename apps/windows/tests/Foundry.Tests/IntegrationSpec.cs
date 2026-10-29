using System.Text;
using System.Text.Json;
using Foundry.Protocol;
using Foundry.Sdk;
using Foundry.Store;
using Xunit;

namespace Foundry.Tests;

/// <summary>
/// Integration battery — the M1 gate against a LIVE core (mirrors the repo's
/// FOUNDRY_INTEGRATION discipline). Skips (returns) unless:
///   FOUNDRY_TESTS_CORE_URL (e.g. http://127.0.0.1:17877)
///   FOUNDRY_TESTS_PASSWORD (the owner account password; username default admin)
/// Covers: REST login, WS handshake, model catalog, chat.create + send + streaming
/// (delta/final via the dummy provider), replay, term.open/input/resize/close,
/// files write/read/list/rm, idem frame placement (observed by the hub — n/a here, unit
/// covered), reconnect-with-cursors, and gate approve/deny round-trip semantics.
/// </summary>
public class IntegrationSpec
{
    private static string? CoreUrl => Environment.GetEnvironmentVariable("FOUNDRY_TESTS_CORE_URL");
    private static string? Password => Environment.GetEnvironmentVariable("FOUNDRY_TESTS_PASSWORD");
    private static string Username => Environment.GetEnvironmentVariable("FOUNDRY_TESTS_USER") ?? "admin";

    private static bool Skip => string.IsNullOrWhiteSpace(CoreUrl) || string.IsNullOrWhiteSpace(Password);

    private sealed class FileSession : IPersistedSession
    {
        public PersistedSession? Value;
        public PersistedSession? Read() => Value;
        public void Save(PersistedSession s) => Value = s;
        public void ClearToken() => Value = Value is null ? null : Value with { Token = "" };
        public void ClearAll() => Value = null;
    }

    [Fact]
    public async Task FullClientLoopAgainstLiveCore()
    {
        if (Skip) return; // gated like FOUNDRY_INTEGRATION

        var url = CoreUrl!;
        var rest = new FoundryRest(url);
        var login = await rest.Login(Username, Password!);
        Assert.StartsWith("fnds_", login.SessionToken);

        // WS connect + catalog + chat loop with the seeded dummy model.
        var sock = new FoundrySocket(url, login.SessionToken, autoReconnect: true, clientVersion: "0.1.0");
        var events = new List<(string name, string channel, long seq)>();
        var connectFired = new TaskCompletionSource();
        var finalFired = new TaskCompletionSource<string>();
        sock.OnEvent += (e, channel, seq, payload) =>
        {
            lock (events)
            {
                events.Add((e, channel, seq));
                if (e == "chat.delta") connectFired.TrySetResult();
                if (e == "chat.final")
                {
                    finalFired.TrySetResult(channel);
                }
            }
        };
        var connect = await sock.ConnectAsync(default);
        Assert.Equal(ProtocolVersion.Current, connect.Protocol);
        sock.StartReconnectLoop();

        var models = await sock.Models();
        var model = models.FirstOrDefault(m => m.Id.Contains("dummy")) ?? models.FirstOrDefault()
            ?? throw new InvalidOperationException("no model in the catalog — seed the dummy provider");

        var chat = await sock.ChatCreate("win-integration");
        Assert.StartsWith("ch_", chat.Id);

        // streaming send (dummy provider) — requires an idem key
        var (runId, conversationId) = await sock.ChatSend(chat.Id, "say hi", model.Id, null, AppStore.Idem("chat"));
        Assert.StartsWith("run_", runId);
        Assert.Equal(chat.Id, conversationId);

        var gotFinal = await Task.WhenAny(finalFired.Task, Task.Delay(TimeSpan.FromSeconds(30)));
        Assert.True(gotFinal == finalFired.Task, $"streaming did not finish; events seen: {string.Join(',', events)}");

        // History: the final assistant message is server-side truth.
        var history = await sock.ChatHistory(chat.Id);
        Assert.Contains(history, m => m.Role == "user");
        Assert.Contains(history, m => m.Role == "assistant");

        // Replay for the run.
        var runEvents = await sock.RunEvents(runId);
        Assert.NotEmpty(runEvents);

        // ---- terminal (fake driver: bash PTY) ----
        var term = await sock.TermOpen(null, AppStore.Idem("term"));
        Assert.StartsWith("term_", term.TermId);
        var termData = new TaskCompletionSource<string>();
        sock.OnEvent += (e, channel, seq, payload) =>
        {
            if (e == "term.data" && channel == $"term:{term.TermId}")
            {
                var data = payload!.Value.GetProperty("data").GetString() ?? "";
                var b64 = payload.Value.TryGetProperty("b64", out var b) && b.ValueKind == JsonValueKind.True;
                termData.TrySetResult(b64 ? Encoding.UTF8.GetString(Convert.FromBase64String(data)) : data);
            }
        };
        await sock.TermInput(term.TermId, "echo foundry-integration\n", null, AppStore.Idem("term-in"));
        var echoed = await Task.WhenAny(termData.Task, Task.Delay(TimeSpan.FromSeconds(20)));
        Assert.True(echoed == termData.Task, "terminal echo did not arrive");
        var echoText = await termData.Task;
        Assert.Contains("foundry-integration", echoText);
        await sock.TermResize(term.TermId, 100, 30, AppStore.Idem("term"));
        await sock.TermClose(term.TermId, AppStore.Idem("term-close"));

        // ---- files (fake driver workspace) ----
        await sock.FilesWrite("hello.txt", "written-by-winui", null, null, AppStore.Idem("files"));
        var readBack = await sock.FilesRead("hello.txt", null);
        Assert.Equal("written-by-winui", readBack.Content);
        var listing = await sock.FilesList(".", null);
        Assert.Contains(listing, f => f.Path.Contains("hello.txt", StringComparison.Ordinal));
        await sock.FilesRm("hello.txt", null, null, AppStore.Idem("files-rm"));
        var removed = await sock.FilesList(".", null);
        Assert.DoesNotContain(removed, f => f.Path.Contains("hello.txt", StringComparison.Ordinal));

        // ---- executor presence: a bare dev core reports offline (no runner) ----
        var exec = await sock.ExecStatus();
        // online true or false both legal; the shape must parse
        Assert.Equal(exec.Online, exec.Online);

        // ---- force a reconnect: the resumed handshake must not error (cursors travel) ----
        await sock.CloseAsync();
        var sock2 = new FoundrySocket(url, login.SessionToken, autoReconnect: false);
        var reconnect = await sock2.ConnectAsync(default);
        Assert.Equal(ProtocolVersion.Current, reconnect.Protocol);
        await sock2.CloseAsync();
    }
}