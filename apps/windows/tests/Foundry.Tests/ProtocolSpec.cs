using System.Text.Json;
using Foundry.Protocol;
using Xunit;

namespace Foundry.Tests;

/// <summary>Wire-shape behavior: frame parsing, display flattening, idem method list.</summary>
public class ProtocolSpec
{
    [Fact]
    public void ParsesResFrame_WithPayloadAndError()
    {
        var (frame, ok) = Frames.Parse("""{"type":"res","id":"7","ok":true,"payload":{"runId":"run_1","conversationId":"ch_1"}}""")!.Value;
        var res = Assert.IsType<ResFrame>(frame);
        Assert.True(ok);
        Assert.True(res.Ok);
        Assert.Equal("7", res.Id);
        Assert.Equal("run_1", res.Payload!.Value.GetProperty("runId").GetString());

        var parsed2 = Frames.Parse("""{"type":"res","id":"8","ok":false,"error":{"code":"unauthorized","message":"invalid token"}}""")!.Value;
        var res2 = Assert.IsType<ResFrame>(parsed2.Frame);
        Assert.False(res2.Ok);
        Assert.Equal("unauthorized", res2.Error!.Code);
    }

    [Fact]
    public void ParsesEventFrame_AndExtractsChannelIds()
    {
        var (frame, ok) = Frames.Parse(
            """{"type":"event","event":"chat.delta","channel":"chat:ch_9","seq":42,"payload":{"runId":"run_1","delta":"hello"}}""")!.Value;
        var ev = Assert.IsType<EventFrame>(frame);
        Assert.True(ok);
        Assert.Equal("chat.delta", ev.Event);
        Assert.Equal("chat:ch_9", ev.Channel);
        Assert.Equal(42, ev.Seq);
        Assert.Equal("ch_9", Channels.ChatId(ev.Channel));
        Assert.Equal("", Channels.RunId(ev.Channel));
        Assert.Equal("run_1", Channels.RunId("run:run_1"));
        Assert.Equal("term_x", Channels.TermId("term:term_x"));
    }

    [Fact]
    public void GarbageAndUnknownFramesAreIgnored()
    {
        Assert.Null(Frames.Parse("not json"));
        Assert.Null(Frames.Parse("""{"type":"mystery"}"""));
        Assert.Null(Frames.Parse("""{"nope":true}"""));
    }

    [Fact]
    public void ParsesServerRequestFrame()
    {
        var (frame, ok) = Frames.Parse("""{"type":"req","id":"srv_1","method":"exec.env.status","params":{"envId":"env_1"}}""")!.Value;
        var req = Assert.IsType<ServerRequestFrame>(frame);
        Assert.True(ok);
        Assert.Equal("exec.env.status", req.Method);
        Assert.Equal("srv_1", req.Id);
    }

    [Fact]
    public void IdempotentMethodSetMatchesProtocol() =>
        Assert.Equal(10, Frames.IdempotentMethods.Split(',').Length);

    [Fact]
    public void GateRequestPayloadCarriesNoState_InjectedAsOpen()
    {
        // run.gate_request = flat Gate WITHOUT state (§ events table) — the store injects "open".
        var payload = JsonDocument.Parse(
            """{"gateId":"g1","runId":"run_1","tool":"shell","args":{"command":"ls"},"policy":"ask","createdAt":"2026-01-01T00:00:00Z"}""").RootElement.Clone();
        var gate = GateParsing.Parse(payload, openState: true);
        Assert.NotNull(gate);
        Assert.Equal("open", gate!.State);
        // And without the injection, State stays null (approved rows carry their own).
        var raw = GateParsing.Parse(JsonDocument.Parse(payload.GetRawText()).RootElement.Clone(), openState: false);
        Assert.Null(raw!.State);
    }

    [Fact]
    public void MessageDisplayFlattensStringAndParts()
    {
        var strContent = JsonDocument.Parse("\"hello world\"").RootElement.Clone();
        var partsContent = JsonDocument.Parse(
            """[{"type":"text","text":"Hello "},{"type":"text","text":"World"}]""").RootElement.Clone();
        var simple = new Message("assistant", strContent, null, null, null);
        var parts = new Message("user", partsContent, null, null, null);
        Assert.Equal("hello world", simple.DisplayText);
        Assert.Equal("Hello World", parts.DisplayText);
        Assert.Equal("", new Message("assistant", null, null, null, null).DisplayText);
    }
}