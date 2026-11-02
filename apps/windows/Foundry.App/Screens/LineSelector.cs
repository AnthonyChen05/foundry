using Foundry_App.Screens;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Foundry_App.Screens;

/// <summary>Picks the bubble template per ChatLine kind (user/assistant/tool/live/hint).</summary>
public sealed class LineSelector : DataTemplateSelector
{
    public DataTemplate? UserTemplate { get; set; }
    public DataTemplate? AssistantTemplate { get; set; }
    public DataTemplate? ToolTemplate { get; set; }
    public DataTemplate? ToolMetaTemplate { get; set; }
    public DataTemplate? LiveTemplate { get; set; }
    public DataTemplate? HintTemplate { get; set; }

    protected override DataTemplate? SelectTemplateCore(object item) =>
        item is ChatLine line ? For(line.Kind) : null;

    protected override DataTemplate? SelectTemplateCore(object item, DependencyObject container) =>
        SelectTemplateCore(item);

    private DataTemplate? For(string kind) => kind switch
    {
        ChatLine.Kinds.User => UserTemplate,
        ChatLine.Kinds.Assistant => AssistantTemplate,
        ChatLine.Kinds.Tool => ToolTemplate,
        ChatLine.Kinds.ToolMeta => ToolMetaTemplate,
        ChatLine.Kinds.Live => LiveTemplate,
        _ => HintTemplate,
    };
}