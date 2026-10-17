package app.foundry.android.data

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.sessionDataStore: androidx.datastore.core.DataStore<Preferences> by preferencesDataStore(name = "foundry_session")

/** What survives a cold start: which server, which session, ntfy preferences. */
data class SessionInfo(
    val serverUrl: String,
    val token: String?,
    val username: String?,
    val ntfyUrl: String?,
    val ntfyTopic: String?,
)

class SessionStore(private val context: Context) {
    private object Keys {
        val SERVER = stringPreferencesKey("serverUrl")
        val TOKEN = stringPreferencesKey("token")
        val USERNAME = stringPreferencesKey("username")
        val NTFY_URL = stringPreferencesKey("ntfyUrl")
        val NTFY_TOPIC = stringPreferencesKey("ntfyTopic")
    }

    fun observe(): Flow<SessionInfo> = context.sessionDataStore.data.map { p ->
        SessionInfo(
            serverUrl = p[Keys.SERVER] ?: "",
            token = p[Keys.TOKEN],
            username = p[Keys.USERNAME],
            ntfyUrl = p[Keys.NTFY_URL],
            ntfyTopic = p[Keys.NTFY_TOPIC],
        )
    }

    suspend fun read(): SessionInfo? = observe().first().takeIf { it.serverUrl.isNotEmpty() }

    suspend fun save(info: SessionInfo) {
        context.sessionDataStore.edit { p ->
            p[Keys.SERVER] = info.serverUrl
            if (info.token != null) p[Keys.TOKEN] = info.token else p.remove(Keys.TOKEN)
            // username kept separately so the login screen can prefill after logout
            if (info.username != null) p[Keys.USERNAME] = info.username else p.remove(Keys.USERNAME)
            if (info.ntfyUrl != null) p[Keys.NTFY_URL] = info.ntfyUrl else p.remove(Keys.NTFY_URL)
            if (info.ntfyTopic != null) p[Keys.NTFY_TOPIC] = info.ntfyTopic else p.remove(Keys.NTFY_TOPIC)
        }
    }

    /** Clear the token but keep server/username/ntfy so the login screen prefills. */
    suspend fun clearToken() {
        context.sessionDataStore.edit { p ->
            p.remove(Keys.TOKEN)
        }
    }
}