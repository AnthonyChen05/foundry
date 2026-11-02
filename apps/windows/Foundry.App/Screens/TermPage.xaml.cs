using Foundry.Protocol;
using Foundry.Sdk;
using Foundry.Store;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Documents;

namespace Foundry_App.Screens;

/// <summary>
/// The PTY terminal page: opens (or rejoins) the chat-bound env's session ONCE per page;
/// renders the store's scrollback (which accumulates term.data — b64-decoded); sends raw
/// keystrokes (b64 UTF-8) + resize. term.close = page-leaving ONLY the session WE joined —
/// the server closes the PTY for the env when we leave (one session per env; exit banner).
/// </summary>
public sealed partial class TermPage : Page
{
    private readonly AppStore _store = App.Host.Store;
    private string _termId = "";
    private int _renderedChars; // how much of the scrollback (tail) is already on screen
    private bool _opened;

    public TermPage()
    {
        InitializeComponent();
        _store.StateChanged += OnState;
        Unloaded += OnLeaving;
        if (_store.State.ActiveChatId is { Length: > 0 } chatId)
        {
            _envId = _store.EnvIdFor(chatId);
            TermEnv.Text = "env: " + (_envId ?? "default");
        }
        _ = OpenAsync();
    }

    private string? _envId;

    private async Task OpenAsync()
    {
        if (_opened) return;
        _opened = true;
        try
        {
            var open = await _store.TermOpenAsync(_envId);
            _termId = open.TermId;
            OnState(_store.State);
            TermStatus.Text = "connected";
            TermEnv.Text = "env: " + (open.EnvId ?? "default");
        }
        catch (FoundryError) when (_envId is not null)
        {
            // The chat-bound env is dead (e.g. the runner restarted) — fall back to the
            // user's default env rather than a dead page; the local run re-materializes.
            _opened = false;
            _envId = null;
            await OpenAsync();
        }
        catch (FoundryError err)
        {
            _opened = false;
            TermStatus.Text = "terminal unavailable: " + err.Message;
        }
    }

    private void OnLeaving(object sender, RoutedEventArgs e)
    {
        _store.StateChanged -= OnState;
        if (_termId.Length > 0)
        {
            _ = _store.TermCloseAsync(_termId);
        }
    }

    private void OnState(AppState s) => App.MarshalToUi(() => Render(s));

    private void Render(AppState s)
    {
        if (_termId.Length == 0) return;
        if (!s.Terminals.TryGetValue(_termId, out var session))
        {
            // The env's session may not exist until the first data arrives
            var open = s.Terminals.Values.FirstOrDefault(t => t.TermId == _termId);
            if (open is null)
            {
                return;
            }
            session = open;
        }
        TermStatus.Text = session.ExitCode is { } code
            ? $"session ended (code {code})"
            : "connected";
        var tail = session.Text.Length > 8000 ? "…" + session.Text[^7999..] : session.Text; // Android's 8k tail display
        if (tail.Length <= _renderedChars) return;
        var fresh = tail[Math.Min(_renderedChars, tail.Length)..];
        _renderedChars = tail.Length;
        var runs = AnsiRenderer.ToRuns(fresh);
        var paragraph = new Paragraph();
        foreach (var run in runs)
        {
            paragraph.Inlines.Add(run);
        }
        BackBuffer.Blocks.Add(paragraph);
        Scroller.UpdateLayout();
        Scroller.ChangeView(null, double.MaxValue, null, disableAnimation: true);
    }

    // ---- input ----

    private void OnLineKey(object sender, KeyRoutedEventArgs args)
    {
        if (args.Key == Windows.System.VirtualKey.Enter)
        {
            args.Handled = true;
            SendLine();
        }
    }

    private void OnSendLine(object sender, RoutedEventArgs e) => SendLine();

    private void SendLine()
    {
        if (_termId.Length == 0) return;
        var line = LineBox.Text;
        LineBox.Text = "";
        _ = _store.TermInputAsync(_termId, line + "\n"); // line-buffered (Android parity)
    }

    private void OnSizeChanged(object sender, SizeChangedEventArgs args)
    {
        // term.resize from the monospace font metrics (cols/rows); guarded to once per settle.
        if (_termId.Length == 0 || args.NewSize.Width < 40 || args.NewSize.Height < 40) return;
        var dpi = XamlRoot.RasterizationScale;
        var cols = (int)(args.NewSize.Width * dpi / 7.22); // Cascadia Mono 13px advance ≈ 7.22
        var rows = (int)(args.NewSize.Height * dpi / 19.0);
        if (cols is < 2 or > 500 || rows is < 2 or > 500) return;
        _lastCols = cols;
        _lastRows = rows;
        _ = _store.TermResizeAsync(_termId, cols, rows);
    }

    private int _lastCols;
    private int _lastRows;
}