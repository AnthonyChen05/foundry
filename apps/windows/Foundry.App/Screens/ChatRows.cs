using System.Collections.ObjectModel;
using Foundry.Protocol;
using Foundry.Sdk;
using Foundry.Store;
using CommunityToolkit.Mvvm.ComponentModel;

namespace Foundry_App.Screens;

/// <summary>
/// The chats page VM — DETERMINISTIC: every apply fully rebuilds Lines/ChatRows/Models
/// from the store snapshot (server truth, no diff state → duplicate rows are impossible),
/// and the PAGE COALESCES applies into one UI tick via a DispatcherQueueTimer (a streaming
/// chat produces dozens of events/sec; rendering once per ~60ms tick keeps the UI idle
/// between bursts). The ListView virtualizes; ItemsUpdatingScrollMode=KeepLastItemInView
/// gives the chat auto-follow. (The first design — per-event StackPanel rebuilds + manual
/// UpdateLayout — deadlocked the UI thread via WinRT finalizer context releases; the
/// second design — an incremental diff — produced duplicate renders. Rebuild + coalesce
/// = both problems gone.)
/// </summary>
public sealed partial class ChatsVm : ObservableObject
{
    public ObservableCollection<ChatRow> ChatRows { get; } = [];
    public ObservableCollection<ChatLine> Lines { get; } = [];
    public ObservableCollection<ModelRow> Models { get; } = [];

    [ObservableProperty]
    public partial int SelectedChatIndex { get; set; } = -1;

    [ObservableProperty]
    public partial bool SendEnabled { get; set; }

    [ObservableProperty]
    public partial string Hint { get; set; } = "";

    [ObservableProperty]
    public partial string StatusText { get; set; } = "";

    private string _activeChatId = "";

    /// <summary>Apply one store snapshot: rebuild everything (UI thread).</summary>
    public void Apply(AppState s)
    {
        ApplyChats(s);
        ApplyLines(s);
        ApplyModels(s);
        SendEnabled = s.Conn == ConnStatus.Open && _activeChatId.Length > 0;
        Hint = SendEnabled ? "" : (s.Conn == ConnStatus.Open ? "create a chat first" : "offline");
        StatusText = s.ConnError.Length > 0 ? s.ConnError : "";
    }

    /// <summary>Apply on a DIFFERENT chat: the same rebuild; the selected index follows.</summary>
    private void ApplyChats(AppState s)
    {
        ChatRows.Clear();
        foreach (var c in s.ChatList)
        {
            ChatRows.Add(ToRow(c));
        }
        var wanted = -1;
        for (var i = 0; i < ChatRows.Count; i++)
        {
            if (ChatRows[i].Id == s.ActiveChatId) { wanted = i; break; }
        }
        SelectedChatIndex = wanted;
    }

    private static ChatRow ToRow(ChatSummary c) => new()
    {
        Id = c.Id,
        Title = string.IsNullOrWhiteSpace(c.Title) ? "New chat" : c.Title,
        Meta = (c.Model ?? "default") + " · " + CompactTime(c.UpdatedAt),
        Location = c.Location == "local" ? "local" : (c.EnvId is not null ? "cloud" : ""),
    };

    private void ApplyLines(AppState s)
    {
        var chatId = s.ActiveChatId;
        Lines.Clear();
        if (chatId.Length == 0)
        {
            _activeChatId = "";
            return;
        }
        _activeChatId = chatId;
        s.Messages.TryGetValue(chatId, out var messages);
        var rendered = false;
        if (messages is not null)
        {
            foreach (var m in messages)
            {
                AppendCanon(m);
                rendered = true;
            }
        }
        // The ONE live draft of this chat = the trailing streaming row.
        var live = s.Drafts.Where(kv => kv.Value.ChatId == chatId).Select(kv => kv.Value).ToList();
        if (live.Count > 0 && live[^1].Text.Length > 0)
        {
            Lines.Add(new ChatLine(ChatLine.Kinds.Live, live[^1].Text + "▍", ""));
            rendered = true;
        }
        if (!rendered)
        {
            Lines.Add(new ChatLine(ChatLine.Kinds.Hint, "Say something — the assistant streams here.", ""));
        }
    }

    internal void AppendCanon(Message m)
    {
        var text = MessageText.Flatten(m.Content);
        var kind = m.Role switch
        {
            "user" => ChatLine.Kinds.User,
            "assistant" => ChatLine.Kinds.Assistant,
            _ => ChatLine.Kinds.Tool,
        };
        while (Lines.Count > 0 && (Lines[^1].Kind == ChatLine.Kinds.Live || Lines[^1].Kind == ChatLine.Kinds.Hint))
        {
            Lines.RemoveAt(Lines.Count - 1); // hint/live placeholders never precede canon rows
        }
        if (kind == ChatLine.Kinds.Assistant && m.ToolCalls is { Count: > 0 } calls)
        {
            foreach (var call in calls)
            {
                Lines.Add(new ChatLine(ChatLine.Kinds.ToolMeta, "⚙ " + call.Function.Name, ""));
            }
        }
        if (text.Length == 0 && kind == ChatLine.Kinds.Tool) return;
        Lines.Add(new ChatLine(kind, kind == ChatLine.Kinds.Tool && text.Length > 300 ? text[..300] + "…" : text, ""));
    }

    /// <summary>Model catalog: rebuild when ids differ (selection lives in the page).</summary>
    private void ApplyModels(AppState s)
    {
        var ids = s.Models.Select(m => m.Id).ToList();
        if (Models.Count == ids.Count && !Models.Zip(ids).Any(p => p.First.Id != p.Second)) return;
        Models.Clear();
        foreach (var m in s.Models)
        {
            Models.Add(new ModelRow(m.Id) { Label = (m.Avatar ?? "") + (m.Name ?? m.Id) });
        }
    }

    private static string CompactTime(string iso)
    {
        if (DateTime.TryParse(iso, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal, out var t))
        {
            var local = t.ToLocalTime();
            var delta = DateTime.UtcNow - t;
            if (delta < TimeSpan.FromMinutes(1)) return "just now";
            if (delta < TimeSpan.FromHours(24)) return local.ToString("HH:mm");
            if (delta < TimeSpan.FromDays(7)) return local.ToString("ddd HH:mm");
            return local.ToString("MMM d");
        }
        return "";
    }
}

/// <summary>Chat list row.</summary>
public sealed class ChatRow
{
    public string Id { get; init; } = "";
    public string Title { get; init; } = "";
    public string Meta { get; init; } = "";
    public string Location { get; init; } = "";
    public Microsoft.UI.Xaml.Visibility ShowLocation =>
        Location.Length > 0 ? Microsoft.UI.Xaml.Visibility.Visible : Microsoft.UI.Xaml.Visibility.Collapsed;
}

/// <summary>One detail line; Kind discriminates the XAML template (via the selector).</summary>
public sealed partial class ChatLine : ObservableObject
{
    public static class Kinds
    {
        public const string User = "user";
        public const string Assistant = "assistant";
        public const string Tool = "tool";
        public const string ToolMeta = "toolmeta";
        public const string Live = "live";
        public const string Hint = "hint";
    }

    public ChatLine(string kind, string text, string at)
    {
        Kind = kind;
        Text = text;
        At = at;
    }

    [ObservableProperty]
    public partial string Kind { get; set; }

    [ObservableProperty]
    public partial string Text { get; set; }

    [ObservableProperty]
    public partial string At { get; set; }
}

/// <summary>Model picker row.</summary>
public sealed record ModelRow(string Id)
{
    public string Label { get; init; } = Id;

    public override string ToString() => Label;
}