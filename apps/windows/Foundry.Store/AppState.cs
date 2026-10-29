using Foundry.Protocol;

namespace Foundry.Store;

/// <summary>
/// Server-authoritative app state — the C# port of the Android AppStore.kt AppState
/// (both are thin-state ports of apps/web/src/lib/foundry.svelte.ts). The store owns all
/// mutation under a lock and hands out this record; referenced dictionaries are treated as
/// read-only by consumers (mutation happens only inside the store).
/// </summary>
public sealed record AppState
{
    /// <summary>"boot" | "login" | "ready"</summary>
    public string Phase { get; init; } = "boot";
    /// <summary>ConnStatus strings: offline|connecting|open|reconnecting|closed.</summary>
    public string Conn { get; init; } = "offline";
    public string ConnError { get; init; } = "";
    public string ServerUrl { get; init; } = "";
    public string Username { get; init; } = "";

    public IReadOnlyDictionary<string, ChatSummary> Chats { get; init; } =
        new Dictionary<string, ChatSummary>();
    public IReadOnlyList<string> ChatOrder { get; init; } = [];

    public string ActiveChatId { get; init; } = "";

    /// <summary>chatId → canonical messages (server truth; chat history extras included).</summary>
    public IReadOnlyDictionary<string, IReadOnlyList<Message>> Messages { get; init; } =
        new Dictionary<string, IReadOnlyList<Message>>();

    /// <summary>runId → live streaming draft (until chat.final replaces it).</summary>
    public IReadOnlyDictionary<string, Draft> Drafts { get; init; } =
        new Dictionary<string, Draft>();

    public IReadOnlyDictionary<string, Run> Runs { get; init; } = new Dictionary<string, Run>();
    public IReadOnlyDictionary<string, IReadOnlyList<Gate>> Gates { get; init; } =
        new Dictionary<string, IReadOnlyList<Gate>>();

    /// <summary>runId → replayed run_events (server truth; replaces live on completion).</summary>
    public IReadOnlyDictionary<string, IReadOnlyList<RunEventItem>> Events { get; init; } =
        new Dictionary<string, IReadOnlyList<RunEventItem>>();

    /// <summary>runId → live WS events not yet covered by a replay (cap 400, drop-oldest).</summary>
    public IReadOnlyDictionary<string, IReadOnlyList<LiveEvent>> Live { get; init; } =
        new Dictionary<string, IReadOnlyList<LiveEvent>>();

    /// <summary>Run ids in first-seen order (newest last).</summary>
    public IReadOnlyList<string> RunOrder { get; init; } = [];
    public string SelectedRunId { get; init; } = "";

    public IReadOnlyList<UiNotification> Notifications { get; init; } = [];
    public IReadOnlyList<Model> Models { get; init; } = [];

    /// <summary>Executor presence (ADR-015): null = probing; Online=false = no local executor.</summary>
    public ExecutorInfo? Executor { get; init; }

    /// <summary>termId → terminal session (data scrollback or lifecycle).</summary>
    public IReadOnlyDictionary<string, TermSession> Terminals { get; init; } =
        new Dictionary<string, TermSession>();

    // ---- convenience projections used by the VMs (non-reactive: re-read on StateChanged) ----

    public IReadOnlyList<ChatSummary> ChatList => ChatOrder
        .Select(id => Chats[id])
        .ToList();

    public IReadOnlyList<UiNotification> RecentNotifications =>
        Notifications.Count > 10 ? Notifications.TakeLast(10).ToList() : Notifications;
}

/// <summary>A live streaming draft.</summary>
public sealed record Draft(string ChatId, string Text);

/// <summary>Live-but-not-yet-replayed timeline row.</summary>
public sealed record LiveEvent(long Seq, string Type, object? Payload, string CreatedAt)
{
    public const string LiveMark = "live";
}

public sealed record UiNotification(string Title, string Body, string? RunId, long AtEpochMs);

/// <summary>Session store shape (persisted outside the app: json + DPAPI in the App host).</summary>
public sealed record PersistedSession(string ServerUrl, string Token, string Username, string? NtfyUrl, string? NtfyTopic)
{
    public bool IsEmpty => ServerUrl.Length == 0 || Token.Length == 0;
}