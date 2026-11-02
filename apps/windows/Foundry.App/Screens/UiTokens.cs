using Microsoft.UI.Xaml.Media;
using Microsoft.UI; // Colors (Microsoft.UI.Colors) — WinUI 3's palette surface
using Windows.UI;   // Color (Windows.UI.Color) — the WinRT color struct brushes take

namespace Foundry_App.Screens;

/// <summary>
/// SAFE brush lookups for code-built UI: ResourceDictionary's indexer THROWS on a missing
/// key and app-level dictionaries don't carry the theme-resource set, so code-built
/// elements take these fixed token colors (matching the web app's dark palette). XAML
/// markup keeps {ThemeResource} for theme-following surfaces.
/// </summary>
public static class UiTokens
{
    /// <summary>The terracotta brand accent (web app's --accent).</summary>
    public static Brush Accent { get; } = new SolidColorBrush(Color.FromArgb(0xFF, 0xD9, 0x77, 0x57));

    /// <summary>Solid readable text on the dark surfaces the shell enforces.</summary>
    public static Brush TextPrimary { get; } = new SolidColorBrush(Colors.White);

    public static Brush TextDim { get; } = new SolidColorBrush(Color.FromArgb(0xB3, 0xE5, 0xE1, 0xD8));

    public static Brush Error { get; } = new SolidColorBrush(Color.FromArgb(0xFF, 0xDD, 0x6E, 0x63)); // --err

    public static Brush Ok { get; } = new SolidColorBrush(Color.FromArgb(0xFF, 0x8D, 0xB0, 0x87));     // --ok

    /// <summary>Subtle bubble surface (the web app's --bg-raised over dark).</summary>
    public static Brush Subtle { get; } = new SolidColorBrush(Color.FromArgb(0x22, 0xFF, 0xFF, 0xFF));

    /// <summary>Transparent sentinel for resetting a Foreground.</summary>
    public static Brush Clear { get; } = new SolidColorBrush(Colors.Transparent);
}