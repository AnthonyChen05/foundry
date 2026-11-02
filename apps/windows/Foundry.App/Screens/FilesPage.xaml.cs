using Foundry.Protocol;
using Foundry.Sdk;
using Foundry.Store;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;

namespace Foundry_App.Screens;

/// <summary>
/// The files browser: workspace-relative navigation over the chat-bound env (or the
/// default). rows = list/navigate (dirs), read→edit→write (files), mkdir, rm (recursive
/// for dirs — the protocol's flags Android omitted). The active-chat binding decides envId.
/// </summary>
public sealed partial class FilesPage : Page
{
    private readonly AppStore _store = App.Host.Store;
    private string _path = ".";

    public FilesPage()
    {
        InitializeComponent();
        PathBox.Text = _path;
        _ = RefreshAsync();
    }

    private string? EnvId => _store.State.ActiveChatId is { Length: > 0 } id ? _store.EnvIdFor(id) : null;

    /// <summary>Env fallback: a chat-bound env can be dead (the runner restarted); the
    /// default env survives. Fall back visibly, once per page-visit.</summary>
    private async Task<T> WithEnv<T>(Func<string?, Task<T>> op)
    {
        var env = EnvId;
        try
        {
            return await op(env).ConfigureAwait(true);
        }
        catch (FoundryError) when (env is not null)
        {
            StatusLine.Text = "chat's local env is dead — using the default env";
            return await op(null).ConfigureAwait(true);
        }
    }

    /// <summary>Void ops (write/mkdir/rm) — same fall-back, no value.</summary>
    private async Task WithEnvVoid(Func<string?, Task> op)
    {
        var env = EnvId;
        try
        {
            await op(env).ConfigureAwait(true);
        }
        catch (FoundryError) when (env is not null)
        {
            StatusLine.Text = "chat's local env is dead — using the default env";
            await op(null).ConfigureAwait(true);
        }
    }

    // ---- listing ----

    public sealed record RowView(string Glyph, string Name, string SizeText, string Path, bool IsDir);

    private async Task RefreshAsync()
    {
        var (rows, err) = (new List<RowView>(), "");
        try
        {
            var entries = await WithEnv(env => _store.FilesListAsync(_path, env));
            foreach (var e in entries)
            {
                rows.Add(new RowView(
                    e.IsDir ? "📁" : "📄",
                    ShortName(e.Path),
                    e.IsDir ? "<dir>" : CompactSize(e.Size),
                    e.Path,
                    e.IsDir));
            }
        }
        catch (FoundryError ex)
        {
            err = ex.Message;
        }
        List.ItemsSource = rows;
        StatusLine.Text = err.Length > 0 ? "listing: " + err : _path + (EnvId is { } e2 ? $" · env {e2}" : " · default env");
    }

    private static string ShortName(string path)
    {
        var idx = path.LastIndexOf('/');
        return idx >= 0 ? path[(idx + 1)..] : path;
    }

    private static string CompactSize(long size) => size switch
    {
        < 1024 => $"{size} B",
        < 1024 * 1024 => $"{size / 1024.0:0.#} KB",
        < 1024L * 1024 * 1024 => $"{size / (1024.0 * 1024):0.#} MB",
        _ => $"{size / (1024.0 * 1024 * 1024):0.#} GB",
    };

    // ---- navigation ----

    private void OnOpenEntry(object sender, DoubleTappedRoutedEventArgs e) => OnOpenSelected();

    private void OnOpenSelected()
    {
        if (List.SelectedItem is not RowView row) return;
        if (row.IsDir)
        {
            Navigate(row.Path);
        }
        else
        {
            _ = OpenReaderAsync(row.Path);
        }
    }

    private void Navigate(string path)
    {
        _path = path;
        PathBox.Text = _path;
        List.ItemsSource = new List<RowView>();
        _ = RefreshAsync();
    }

    private void OnUp(object sender, RoutedEventArgs e) => Navigate(ParentOf(_path));

    private void OnRoot(object sender, RoutedEventArgs e) => Navigate(".");

    private void OnRefresh(object sender, RoutedEventArgs e) => _ = RefreshAsync();

    private void OnPathKey(object sender, KeyRoutedEventArgs args)
    {
        if (args.Key == Windows.System.VirtualKey.Enter)
        {
            args.Handled = true;
            Navigate(PathBox.Text.Trim().Length == 0 ? "." : PathBox.Text.Trim());
        }
    }

    private static string ParentOf(string path)
    {
        if (path == "." || path.Length == 0) return ".";
        var trimmed = path.TrimEnd('/');
        var idx = trimmed.LastIndexOf('/');
        return idx < 0 ? "." : (idx == 0 ? "." : trimmed[..idx]);
    }

    // ---- read / edit / write ----

    private string? _openPath;

    private async Task OpenReaderAsync(string path)
    {
        try
        {
            var read = await WithEnv(env => _store.FilesReadAsync(path, env));
            _openPath = path;
            if (read.B64 is { Length: > 0 } b64)
            {
                PreviewName.Text = ShortName(path);
                PreviewNote.Text = "(binary file — edit disabled)";
                PreviewBody.Text = "";
                PreviewBody.IsEnabled = false;
                SaveBtn.IsEnabled = false;
            }
            else
            {
                PreviewName.Text = ShortName(path);
                PreviewNote.Text = read.Content.Length == 0 ? "(empty file)" : $"{read.Content.Length} chars";
                PreviewBody.Text = read.Content;
                PreviewBody.IsEnabled = true;
                SaveBtn.IsEnabled = true;
            }
            Preview.Visibility = Visibility.Visible;
        }
        catch (FoundryError err)
        {
            PreviewNote.Text = "read: " + err.Message;
        }
    }

    private async void OnSave(object sender, RoutedEventArgs e)
    {
        if (_openPath is null) return;
        try
        {
            await WithEnvVoid(env => _store.FilesWriteAsync(_openPath, PreviewBody.Text, env));
            PreviewNote.Text = "saved " + ShortName(_openPath) + " ✓";
        }
        catch (FoundryError err)
        {
            PreviewNote.Text = "write: " + err.Message;
        }
    }

    // ---- mkdir / rm ----

    private async void OnMkdir(object sender, RoutedEventArgs e)
    {
        // Simple inline: a folder named from the path-box's suffix; recursive always.
        var dialog = new ContentDialog
        {
            Title = "New folder",
            XamlRoot = XamlRoot,
            PrimaryButtonText = "Create",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Primary,
        };
        var box = new TextBox { PlaceholderText = "folder name" };
        var contents = new StackPanel { Spacing = 8 };
        contents.Children.Add(box);
        dialog.Content = contents;
        dialog.PrimaryButtonClick += async (_, args) =>
        {
            var name = box.Text.Trim();
            if (name.Length == 0)
            {
                args.Cancel = true;
                return;
            }
            var target = _path == "." ? name : _path.TrimEnd('/') + "/" + name;
            try
            {
                await WithEnvVoid(env => _store.FilesMkdirAsync(target, recursive: true, env));
                StatusLine.Text = "created " + target;
                await RefreshAsync();
            }
            catch (FoundryError err)
            {
                StatusLine.Text = "mkdir: " + err.Message;
            }
        };
        await dialog.ShowAsync();
    }

    private async void OnDeleteEntry(object sender, RoutedEventArgs e)
    {
        if (sender is FrameworkElement { DataContext: RowView row })
        {
            var dialog = new ContentDialog
            {
                Title = "Delete " + ShortName(row.Path) + "?",
                Content = row.IsDir ? "Folder + everything under it." : "File",
                XamlRoot = XamlRoot,
                PrimaryButtonText = "Delete",
                CloseButtonText = "Cancel",
                DefaultButton = ContentDialogButton.Close,
            };
            var result = await dialog.ShowAsync();
            if (result != ContentDialogResult.Primary) return;
            try
            {
                await WithEnvVoid(env => _store.FilesRmAsync(row.Path, row.IsDir, env));
                await RefreshAsync();
            }
            catch (FoundryError err)
            {
                StatusLine.Text = "rm: " + err.Message;
            }
        }
    }
}