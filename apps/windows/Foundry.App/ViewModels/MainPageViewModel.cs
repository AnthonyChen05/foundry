using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace Foundry_App.ViewModels;

/// <summary>
/// Sample ViewModel using CommunityToolkit.Mvvm source generators.
/// Properties use the partial-property form of <see cref="ObservableProperty"/> —
/// the AOT/WinRT-compatible form required in WinUI 3 (field form warns MVVMTK0045).
/// </summary>
public partial class MainPageViewModel : ObservableObject
{
    [ObservableProperty]
    public partial string Greeting { get; set; } = "Hello, WinUI!";

    [ObservableProperty]
    public partial int Counter { get; set; }

    [RelayCommand]
    private void Increment()
    {
        Counter++;
    }

    [RelayCommand]
    private void Decrement()
    {
        Counter--;
    }
}