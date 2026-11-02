using Microsoft.UI.Xaml;

namespace Foundry_App;

/// <summary>
/// The application window: title bar + a root frame whose content the Router swaps per
/// store phase (Setup → Login → MainShell).
/// </summary>
public sealed partial class MainWindow : Window
{
    /// <summary>The root frame the Router navigates (public: Router is out-of-class).</summary>
    public Microsoft.UI.Xaml.Controls.Frame Root { get; private set; } = null!;

    public MainWindow()
    {
        InitializeComponent();

        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);

        AppWindow.SetIcon("Assets/AppIcon.ico");

        Title = "Foundry";
        Root = RootFrame;
        // The Router navigates Root on the first store state after boot.
    }
}