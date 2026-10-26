package app.foundry.android.data

import app.foundry.android.core.FoundryError
import app.foundry.android.core.Session
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/** ADR-015 push-to-cloud outcome. */
@Serializable
data class PushResult(val pushRunId: String, val cloudEnvId: String)

/** Admin providers (§2.1) as the phone needs them. */
@Serializable
data class ProviderRow(
    val id: String,
    val kind: String,
    val baseUrl: String? = null,
    val enabled: Boolean = true,
    val hasKey: Boolean = false,
)

@Serializable
data class UpsertProviderResult(
    val id: String,
    val models: List<String> = emptyList(),
    val pulled: Boolean? = null,
    val pullError: String? = null,
)

@Serializable
private data class LoginResult(val sessionToken: String, val expiresAt: String)

@Serializable
private data class OkResult(val ok: Boolean = true)

/**
 * REST plane (§2/§2.1) for what the WS cannot do: login before a socket
 * exists, the self-service password change, and chat push-to-cloud. Errors
 * use the OpenAI envelope `{ error: { code, message } }`.
 */
class FoundryRest(private val baseUrl: String) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(180, TimeUnit.SECONDS) // push pulls + restores a workspace
        .build()

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }
    private val jsonMedia = "application/json".toMediaType()

    suspend fun login(username: String, password: String): Session {
        val body = post("/v1/auth/login", buildJsonObject {
            put("username", username)
            put("password", password)
        }, token = null)
        val parsed = runCatching { json.decodeFromString(LoginResult.serializer(), body) }.getOrNull()
        return if (parsed != null) {
            Session(parsed.sessionToken, parsed.expiresAt)
        } else {
            throw FoundryError("internal", "malformed login response")
        }
    }

    /** Self-service password change (401 on wrong current password). */
    suspend fun changePassword(token: String, currentPassword: String, newPassword: String) {
        post("/v1/auth/password", buildJsonObject {
            put("currentPassword", currentPassword)
            put("newPassword", newPassword)
        }, token = token)
    }

    /** Push a chat's local workspace into a cloud env and reconcile deps (ADR-015). */
    suspend fun pushChat(token: String, chatId: String): PushResult {
        val body = post("/v1/chats/$chatId/push", buildJsonObject { }, token = token)
        return json.decodeFromString(PushResult.serializer(), body)
    }

    // -- admin: providers (settings → providers) ------------------------------------

    suspend fun adminListProviders(token: String): List<ProviderRow> {
        val body = get("/v1/admin/providers", token = token)
        @Serializable
        data class Rows(val providers: List<ProviderRow>)
        return json.decodeFromString(Rows.serializer(), body).providers
    }

    /**
     * Upsert a provider. `models` null/empty = the SERVER auto-pulls them
     * from the provider's OpenAI-compatible /models (openai_compat only);
     * ids are `<provider>/<id>`-prefixed server-side.
     */
    suspend fun upsertProvider(
        token: String,
        kind: String,
        baseUrl: String,
        apiKey: String?,
        models: List<String>? = null,
    ): UpsertProviderResult {
        val body = post("/v1/admin/providers", buildJsonObject {
            put("kind", kind)
            put("baseUrl", baseUrl)
            if (apiKey != null && apiKey.isNotBlank()) put("apiKey", apiKey)
            if (!models.isNullOrEmpty()) {
                val rows = models.filter { it.isNotBlank() }.map { id -> buildJsonObject { put("id", id.trim()) } }
                put("models", kotlinx.serialization.json.JsonArray(rows))
            }
        }, token = token)
        return json.decodeFromString(UpsertProviderResult.serializer(), body)
    }

    suspend fun deleteProvider(token: String, id: String) {
        del("/v1/admin/providers/$id", token = token)
    }

    private suspend fun get(path: String, token: String?): String = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url(baseUrl.trimEnd('/') + path)
        if (token != null) builder.addHeader("Authorization", "Bearer $token")
        val request = builder.get().build()
        try {
            client.newCall(request).execute().use { res ->
                val text = res.body?.string() ?: ""
                if (res.isSuccessful) text else throw restError(text, res.code)
            }
        } catch (e: FoundryError) {
            throw e
        } catch (e: Exception) {
            throw FoundryError("internal", e.message ?: e.javaClass.simpleName)
        }
    }

    private suspend fun del(path: String, token: String?): String = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url(baseUrl.trimEnd('/') + path)
        if (token != null) builder.addHeader("Authorization", "Bearer $token")
        val request = builder.delete().build()
        try {
            client.newCall(request).execute().use { res ->
                val text = res.body?.string() ?: ""
                if (res.isSuccessful) text else throw restError(text, res.code)
            }
        } catch (e: FoundryError) {
            throw e
        } catch (e: Exception) {
            throw FoundryError("internal", e.message ?: e.javaClass.simpleName)
        }
    }

    private suspend fun post(path: String, body: JsonObject, token: String?): String = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url(baseUrl.trimEnd('/') + path)
        if (token != null) builder.addHeader("Authorization", "Bearer $token")
        val request = builder.post(body.toString().toRequestBody(jsonMedia)).build()
        try {
            client.newCall(request).execute().use { res ->
                val text = res.body?.string() ?: ""
                if (res.isSuccessful) {
                    text
                } else {
                    throw restError(text, res.code)
                }
            }
        } catch (e: FoundryError) {
            throw e
        } catch (e: Exception) {
            throw FoundryError("internal", e.message ?: e.javaClass.simpleName)
        }
    }
}

/** Map the OpenAI error envelope (or a bare HTTP status) to a FoundryError. */
fun restError(body: String, status: Int): FoundryError {
    val code = when {
        status == 401 -> "unauthorized"
        status == 400 -> "bad_request"
        status == 404 -> "not_found"
        status in 402..499 -> "denied"
        status == 429 || status == 503 -> "capacity"
        else -> "internal"
    }
    val parsed = runCatching { Json { ignoreUnknownKeys = true }.decodeFromString(RestErrorBody.serializer(), body) }.getOrNull()
    return FoundryError(parsed?.error?.code ?: code, parsed?.error?.message ?: "HTTP $status")
}

@Serializable
private data class RestErrorBody(val error: RestError? = null) {
    @Serializable
    data class RestError(val code: String? = null, val message: String? = null)
}