using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Foundry.Protocol;

namespace Foundry.Sdk;

/// <summary>
/// REST client — port of packages/sdk-ts/src/client.ts + Android data/FoundryRest.kt.
/// Bearer token on every call (session token or API key — verifyToken accepts both);
/// request bodies serialize with the wire context (camelCase, write-nulls-ignored);
/// OpenAI error envelopes normalize into FoundryError with Android's status→code map.
/// </summary>
public sealed class FoundryRest : IFdRest, IDisposable
{
    public const string ClientVersion = "0.1.0";
    private static readonly JsonSerializerOptions WireOptions = WireRuntime.Options;
    private const string JsonMediaType = "application/json";

    private readonly HttpClient _http;
    private readonly HttpClient _pushHttp; // long-timeout client: POST push awaits the reconcile run
    private readonly string _baseUrl;

    public FoundryRest(string baseUrl, string? token = null)
    {
        _baseUrl = BaseUrlNormalizer.StripTrailingSlash(baseUrl);
        Token = token;
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(100) };
        _pushHttp = new HttpClient { Timeout = TimeSpan.FromSeconds(180) };
        _http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", $"FoundryWindows/{ClientVersion}");
        _pushHttp.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", $"FoundryWindows/{ClientVersion}");
    }

    public string BaseUrl => _baseUrl;
    public string? Token { get; set; }

    public void SetToken(string? token) => Token = token;

    public void Dispose()
    {
        _http.Dispose();
        _pushHttp.Dispose();
    }

    // ------------------------------------------------------------------
    // auth (ADR-014: login/password are the user-facing auth surface)
    // ------------------------------------------------------------------

    public async Task<AuthLoginResult> Login(string username, string password)
    {
        var payload = await SendAsync(_http, () =>
            new HttpRequestMessage(HttpMethod.Post, $"{_baseUrl}/v1/auth/login")
            {
                Content = ToJsonContent(new { username, password }),
            }).ConfigureAwait(false);
        return payload.Deserialize(WireJsonContext.Default.AuthLoginResult)
            ?? throw new FoundryError(ErrorCodes.Internal, "bad login payload");
    }

    public async Task ChangePassword(string currentPassword, string newPassword)
    {
        await SendAsync(_http, () =>
            new HttpRequestMessage(HttpMethod.Post, $"{_baseUrl}/v1/auth/password")
            {
                Content = ToJsonContent(new { currentPassword, newPassword }),
            }).ConfigureAwait(false);
    }

    /// <summary>Reconcile the chat's local workspace into a backend env (ADR-015). This call
    /// AWAITS the reconcile run — long-timeout client (Android parity: 180s read).</summary>
    public async Task<(string PushRunId, string CloudEnvId)> PushChat(string chatId)
    {
        var payload = await SendAsync(_pushHttp, () =>
            new HttpRequestMessage(HttpMethod.Post, $"{_baseUrl}/v1/chats/{Uri.EscapeDataString(chatId)}/push")
            {
                Content = ToJsonContent(new { }),
            }).ConfigureAwait(false);
        return (
            payload.TryGetProperty("pushRunId", out var prid) ? prid.GetString() ?? "" : "",
            payload.TryGetProperty("cloudEnvId", out var ceid) ? ceid.GetString() ?? "" : "");
    }

    // ------------------------------------------------------------------
    // admin providers (settings; models auto-pull server-side)
    // ------------------------------------------------------------------

    public sealed record ProviderRow(string Id, string Kind, string? BaseUrl, bool HasKey);

    public async Task<List<ProviderRow>> ListProviders()
    {
        var payload = await GetJson($"{_baseUrl}/v1/admin/providers").ConfigureAwait(false);
        var data = payload.TryGetProperty("providers", out var p) && p.ValueKind == JsonValueKind.Array
            ? p
            : throw new FoundryError(ErrorCodes.Internal, "bad providers payload");
        var rows = new List<ProviderRow>();
        foreach (var row in data.EnumerateArray())
        {
            rows.Add(new ProviderRow(
                GetString(row, "id"),
                GetString(row, "kind"),
                row.TryGetProperty("baseUrl", out var b) && b.ValueKind == JsonValueKind.String ? b.GetString() : null,
                row.TryGetProperty("hasKey", out var hk) && hk.ValueKind == JsonValueKind.True));
        }
        return rows;
    }

    /// <summary>Upsert a provider; null models = server auto-pulls from the provider's own
    /// /models (or the Anthropic shim). Returns the resulting model list + pull outcome.</summary>
    public async Task<(string Id, IReadOnlyList<string> Models, bool? Pulled, string? PullError)> UpsertProvider(
        string? id, string kind, string baseUrl, string? apiKey, IReadOnlyList<string>? models)
    {
        var body = new Dictionary<string, object?>
        {
            ["id"] = id,
            ["kind"] = kind,
            ["baseUrl"] = baseUrl,
            ["apiKey"] = string.IsNullOrWhiteSpace(apiKey) ? null : apiKey,
            // Dictionary preserves key case; anonymous members go camelCase via WireOptions.
            ["models"] = models is { Count: > 0 }
                ? models.Select(m => new Dictionary<string, object?> { ["id"] = m }).ToList()
                : null,
        };
        var payload = await PostJson($"{_baseUrl}/v1/admin/providers", body).ConfigureAwait(false);
        var modelIds = payload.TryGetProperty("models", out var ms) && ms.ValueKind == JsonValueKind.Array
            ? ms.EnumerateArray().Select(m => m.ValueKind == JsonValueKind.String ? m.GetString() ?? "" : "").Where(s => s.Length > 0).ToList()
            : new List<string>();
        return (
            GetString(payload, "id"),
            modelIds,
            payload.TryGetProperty("pulled", out var pulled) && pulled.ValueKind is JsonValueKind.True or JsonValueKind.False
                ? pulled.GetBoolean()
                : null,
            payload.TryGetProperty("pullError", out var pe) && pe.ValueKind == JsonValueKind.String ? pe.GetString() : null);
    }

    public async Task DeleteProvider(string id)
    {
        using var req = new HttpRequestMessage(
            HttpMethod.Delete,
            $"{_baseUrl}/v1/admin/providers/{Uri.EscapeDataString(id)}");
        await SendAsync(_http, () => req).ConfigureAwait(false);
    }

    // ------------------------------------------------------------------
    // plumbing
    // ------------------------------------------------------------------

    private static StringContent ToJsonContent(object value) =>
        new(JsonSerializer.Serialize(value, WireOptions), Encoding.UTF8, JsonMediaType);

    private async Task<JsonElement> GetJson(string url) =>
        await SendAsync(_http, () => new HttpRequestMessage(HttpMethod.Get, url)).ConfigureAwait(false);

    private async Task<JsonElement> PostJson(string url, object body)
    {
        var str = ToJsonContent(body);
        return await SendAsync(_http, () => new HttpRequestMessage(HttpMethod.Post, url) { Content = str }).ConfigureAwait(false);
    }

    /// <summary>Bearer token attaches at send time (it can change after construction).</summary>
    private async Task<JsonElement> SendAsync(HttpClient client, Func<HttpRequestMessage> make)
    {
        using var req = make();
        if (Token is { Length: > 0 } t)
        {
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", t);
        }
        using var resp = await client.SendAsync(req).ConfigureAwait(false);
        var text = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
        {
            throw MapRestError((int)resp.StatusCode, text);
        }
        if (text.Length == 0)
        {
            return JsonSerializer.SerializeToElement(new Dictionary<string, object?>());
        }
        try
        {
            return JsonSerializer.Deserialize(text, WireJsonContext.Default.JsonElement);
        }
        catch
        {
            throw new FoundryError(ErrorCodes.Internal, $"unparseable response: {Truncate(text)}");
        }
    }

    /// <summary>Normalize an OpenAI error envelope into FoundryError (Android restError map:
    /// 401→unauthorized, 400→bad_request, 404→not_found, 402–499→denied, 429/503→capacity).</summary>
    public static FoundryError MapRestError(int status, string body)
    {
        var message = ExtractOpenAiMessage(body) ?? $"HTTP {status}";
        var code = status switch
        {
            400 => ErrorCodes.BadRequest,
            401 or 403 => ErrorCodes.Unauthorized,
            404 => ErrorCodes.NotFound,
            >= 402 and < 500 => ErrorCodes.Denied,
            429 or 503 => ErrorCodes.Capacity,
            _ => ErrorCodes.Internal,
        };
        return new FoundryError(code, message, status is 429 or 503);
    }

    private static string? ExtractOpenAiMessage(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("error", out var err)
                && err.ValueKind == JsonValueKind.Object
                && err.TryGetProperty("message", out var msg)
                && msg.ValueKind == JsonValueKind.String)
            {
                return msg.GetString();
            }
        }
        catch { /* not JSON — fall through */ }
        return body.Length > 0 ? Truncate(body) : null;
    }

    private static string Truncate(string s) => s.Length <= 200 ? s : s[..200] + "…";

    private static string GetString(JsonElement el, string key) =>
        el.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
}