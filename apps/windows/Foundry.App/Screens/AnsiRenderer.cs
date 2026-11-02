using Microsoft.UI.Text;
using Microsoft.UI.Xaml.Documents;
using Windows.UI; // color struct
using Microsoft.UI.Xaml.Media;

namespace Foundry_App.Screens;

/// <summary>
/// Minimal ANSI/VT renderer for the server PTY scrollback: turns the decoded term stream
/// into XAML Runs w/ SGR color/bold/italic. Cursor-movement/OSC are STRIPPED (the term view
/// = a scrollback reader, not a TUI — the Android floor = plain text; colors still render).
/// Covered SGR: 0 reset, 1 bold, 3 italic, 22/23 off, 30–37 fg, 90–97 bright, 39 default.
/// The 256/truecolor palette + bg-rendering = a later slice (the runs parse-safe: unknown
/// codes ignored).
/// </summary>
public static class AnsiRenderer
{
    private static readonly Color[] Base =
    [
        From("#3b4252"), From("#dd6e63"), From("#8db087"), From("#e0ac69"),
        From("#81a1c1"), From("#b48ead"), From("#88c0d0"), From("#e5e9f0"),
    ];

    private static readonly Color[] Bright =
    [
        From("#616e88"), From("#e28a6c"), From("#a3be8c"), From("#ebcb8b"),
        From("#9cc0dd"), From("#c48ec4"), From("#8fbcbb"), From("#eceff4"),
    ];

    private static Color From(string hex) =>
        Color.FromArgb(
            0xFF,
            Convert.ToByte(hex[1..3], 16),
            Convert.ToByte(hex[3..5], 16),
            Convert.ToByte(hex[5..7], 16));

    public const string DefaultFont = "Cascadia Mono"; // falls back to Consolas when absent

    private static readonly System.Text.RegularExpressions.Regex VtStrip = new(
        "\u001b\\[[0-9;?]*[ -/]*[@-~]|\u001b\\][^\u0007\u001b]*(\u0007|\u001b\\\\)|\u001b[@-_]",
        System.Text.RegularExpressions.RegexOptions.Compiled);

    /// <summary>Strip VT entirely (the Android-parity fallback).</summary>
    public static string Strip(string text) => VtStrip.Replace(text, "");

    private static Run Plain(string text) => new() { Text = text };

    private static Run MakeRun(string text, Color fg, bool bold, bool italic) => new()
    {
        Text = text,
        Foreground = new SolidColorBrush(fg),
        FontWeight = bold ? FontWeights.Bold : FontWeights.Normal,
        FontStyle = italic ? Windows.UI.Text.FontStyle.Italic : Windows.UI.Text.FontStyle.Normal,
    };

    /// <summary>Runs for a chunk of decoded terminal bytes.</summary>
    public static IReadOnlyList<Run> ToRuns(string text)
    {
        if (text.IndexOf('\u001b') < 0)
        {
            return [Plain(text)];
        }
        var runs = new List<Run>();
        var fg = (Color?)null;
        var bold = false;
        var italic = false;
        var plainStart = 0;
        var i = 0;
        void Flush(int end)
        {
            if (end > plainStart)
            {
                runs.Add(fg is { } c ? MakeRun(text[plainStart..end], c, bold, italic) : Plain(text[plainStart..end]));
            }
            plainStart = end;
        }
        while (i < text.Length)
        {
            var esc = text.IndexOf('\u001b', i);
            if (esc < 0) break;
            var seq = ParseSequence(text, esc);
            if (seq is null)
            {
                // Unparseable escape: keep the bytes as text up to +1 (never lose content).
                i = esc + 1;
                continue;
            }
            var (kind, body, next) = seq.Value;
            Flush(esc);
            if (kind == "sgr")
            {
                var codes = body.ReplacePrefixSemi();
                foreach (var raw in codes.Split(';', StringSplitOptions.RemoveEmptyEntries))
                {
                    if (!int.TryParse(raw, out var code)) continue;
                    switch (code)
                    {
                        case 0: fg = null; bold = italic = false; break;
                        case 1: bold = true; break;
                        case 3: italic = true; break;
                        case 22: bold = false; break;
                        case 23: italic = false; break;
                        case 39: fg = null; break;
                        case >= 30 and <= 37: fg = Base[code - 30]; break;
                        case >= 90 and <= 97: fg = Bright[code - 90]; break;
                        default: break; // 256/4-bit-bg etc: later slice; ignored quietly
                    }
                }
            }
            i = next;
            plainStart = i;
        }
        Flush(text.Length);
        if (runs.Count == 0 && text.Length > 0) runs.Add(Plain(text));
        return runs;
    }

    private static (string Kind, string Body, int Next)? ParseSequence(string text, int esc)
    {
        if (esc + 1 >= text.Length) return null;
        var c1 = text[esc + 1];
        if (c1 == '[')
        {
            var j = esc + 2;
            while (j < text.Length && (char.IsAsciiDigit(text[j]) || text[j] == ';' || text[j] == '?')) j++;
            if (j >= text.Length) return null;
            var final = text[j];
            if (final < '@' || final > '~') return null;
            var body = text[(esc + 2)..j].TrimEnd('?', ';');
            return (final == 'm' ? "sgr" : "csi", body, j + 1);
        }
        if (c1 == ']')
        {
            // OSC: BEL or ST (ESC \) terminated
            var j = esc + 2;
            while (j < text.Length)
            {
                if (text[j] == '\u0007') return ("osc", "", j + 1);
                if (text[j] == '\u001b' && j + 1 < text.Length && text[j + 1] == '\\') return ("osc", "", j + 2);
                j++;
            }
            return null;
        }
        if (c1 is >= '@' and <= '_') return ("csi", "", esc + 2);
        return null;
    }

    private static string ReplacePrefixSemi(this string s) => s.Length > 0 && s[0] == ';' ? "0" + s : s;
}