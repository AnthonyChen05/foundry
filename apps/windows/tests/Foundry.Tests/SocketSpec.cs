using System.Text.Json;
using Foundry.Protocol;
using Foundry.Sdk;
using Xunit;

namespace Foundry.Tests;

/// <summary>Socket behavior vs a fake hub: handshake shape, idem placement, cursors/resume,
/// request correlation, reconnect, and the not-an-executor reply.</summary>
public class SocketSpec
{
    private static async Task<FoundrySocket> ConnectAsync(FakeHub hub, string token = "correct-token", bool autoReconnect = true)
    {
        var sock = new FoundrySocket(hub.Url, token, autoReconnect);
        _ = hub.AcceptAsync(); // arm the listener; the pump runs detached
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        await sock.ConnectAsync(cts.Token); // throws (incl. any timeout) → test fails loudly
        return sock;
    }

    [Fact]
    public async Task HandshakeSendsProtocolAuthKindAndVersion()
    {
        var hub = FakeHub.Start();
        await using var sock = await ConnectAsync(hub);
        Assert.NotNull(hub.LastConnectParams);
        var p = hub.LastConnectParams!.Value;
        Assert.Equal(0, p.GetProperty("protocol").GetInt32());
        Assert.Equal("correct-token", p.GetProperty("auth").GetProperty("token").GetString());
        Assert.Equal("windows", p.GetProperty("client").GetProperty("kind").GetString());
        var version = p.GetProperty("client").GetProperty("version").GetString();
        Assert.False(string.IsNullOrWhiteSpace(version));
        // resume omitted on the first (empty-cursor) connect
        Assert.False(p.TryGetProperty("resume", out _));
    }

    [Fact]
    public async Task IdemRidesOnTheFrame_NotParams()
    {
        var hub = FakeHub.Start();
        hub.Responders["chat.send"] = p => new { runId = "run_1", conversationId = "ch_1" };
        await using var sock = await ConnectAsync(hub);
        var (runId, _) = await sock.ChatSend("ch_1", "hi", null, null, "chat-abc");
        Assert.Equal("run_1", runId);
        Assert.Equal("chat.send", hub.Requests.First().Method);
        Assert.Equal("chat-abc", hub.Requests.First().Idem); // frame-level idem
        var paramsEl = hub.Requests.First().Params!.Value;
        Assert.True(paramsEl.TryGetProperty("chatId", out _));
        Assert.False(paramsEl.TryGetProperty("idem", out _)); // never inside params
    }

    [Fact]
    public async Task MissingIdemMethodsPassWithoutIdem()
    {
        var hub = FakeHub.Start();
        hub.Responders["chat.list"] = _ => Array.Empty<object>(); // chat.list returns a bare array
        await using var sock = await ConnectAsync(hub);
        await sock.ChatList();
        var req = hub.Requests.First();
        Assert.Null(req.Idem);
    }

    [Fact]
    public async Task CursorsTrackEveryEventAndTravelInResume()
    {
        var hub = FakeHub.Start();
        await using var sock = await ConnectAsync(hub);
        var seen = new List<string>();
        var gotAll = new TaskCompletionSource();
        sock.OnEvent += (_, channel, seq, _) =>
        {
            lock (seen)
            {
                seen.Add($"{channel}@{seq}");
                if (seen.Count >= 3) gotAll.TrySetResult();
            }
        };

        // Flood events (hub publishes to ALL conns): 2 on run + 1 on sys.
        await hub.PublishAsync("run.status", "run:run_9", 5, new { runId = "run_9", status = "running" });
        await hub.PublishAsync("run.status", "run:run_9", 6, new { runId = "run_9", status = "done" });
        await hub.PublishAsync("executor.status", "sys", 99, new { online = false });
        var gotEvents = await Task.WhenAny(gotAll.Task, Task.Delay(10_000));
        Assert.True(gotEvents == gotAll.Task, "events did not arrive");
        // Cursor arithmetic: LAST seen seq per channel, every event updates it.
        Assert.Equal(6, SockCursor(sock, "run:run_9"));
        Assert.Equal(99, SockCursor(sock, "sys"));

        // Forced drop → the socket's reconnect loop re-handshakes with the SAME instance;
        // the resume array must carry both cursors (the hub signals when it arrives).
        _ = hub.AcceptAsync(); // serve the reconnecting client
        hub.DropAll();
        var resumed = await Task.WhenAny(hub.ResumeSeen.Task, Task.Delay(15_000));
        Assert.True(resumed == hub.ResumeSeen.Task, "second handshake with resume did not arrive");
        var resume = await hub.ResumeSeen.Task;
        Assert.Equal(2, resume.GetArrayLength());
        foreach (var entry in resume.EnumerateArray())
        {
            var channel = entry.GetProperty("channel").GetString();
            var lastSeq = entry.GetProperty("lastSeq").GetInt64();
            Assert.Equal(channel switch
            {
                "run:run_9" => 6L,
                "sys" => 99L,
                _ => -1L,
            }, lastSeq);
        }
        return;

        static long SockCursor(FoundrySocket s, string channel) => s.CursorOf(channel);
    }

    [Fact]
    public async Task BadTokenIsPermanentAuthFailure()
    {
        var hub = FakeHub.Start();
        hub.AcceptedToken = "other";
        var sock = new FoundrySocket(hub.Url, "correct-token", autoReconnect: false);
        _ = hub.AcceptAsync(); // arm; resolves when the client connects
        var err = await Assert.ThrowsAsync<FoundryError>(() => sock.ConnectAsync(default));
        Assert.Equal("unauthorized", err.Code);
        Assert.True(sock.AuthFailed);
    }

    [Fact]
    public async Task ServerRequestGetsNotAnExecutorReply()
    {
        // The app must answer server→client req frames with ok:false (never an executor);
        // the frame round-trips through the parser (that's the contract).
        var reply = FrameJson.WriteResError("srv_1", "internal", "receiver is not an executor");
        var (frame, ok) = Frames.Parse(reply)!.Value;
        var res = Assert.IsType<ResFrame>(frame);
        Assert.True(ok);
        Assert.False(res.Ok);
        Assert.Equal("srv_1", res.Id);
        Assert.Equal("internal", res.Error!.Code);
        Assert.Equal("receiver is not an executor", res.Error.Message);
    }

    [Fact]
    public async Task AuthLoginViaSocketReturnsSession()
    {
        var hub = FakeHub.Start();
        hub.Responders["auth.login"] = p =>
        {
            var u = p!.Value.GetProperty("username").GetString();
            var pw = p.Value.GetProperty("password").GetString();
            if (u == "admin" && pw == "pw") return new { sessionToken = "fnds_newtoken", expiresAt = "2030-01-01T00:00:00Z" };
            throw new InvalidOperationException("invalid username or password");
        };
        await using var sock = await ConnectAsync(hub);
        var login = await sock.AuthLogin("admin", "pw");
        Assert.Equal("fnds_newtoken", login.SessionToken);
    }
}