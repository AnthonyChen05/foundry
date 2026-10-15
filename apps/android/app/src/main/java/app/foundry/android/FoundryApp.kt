package app.foundry.android

import android.app.Application
import android.content.Context
import app.foundry.android.data.AppStore
import app.foundry.android.data.SessionStore
import app.foundry.android.notify.Notifier
import app.foundry.android.notify.NtfyClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** Process-wide holder: the session stores + the current AppStore + ntfy subscription. */
class FoundryApp : Application() {
    lateinit var sessions: SessionStore
        private set
    lateinit var ntfy: NtfyClient
        private set

    /** A fresh AppStore per login; recreated by MainActivity after logout. */
    var store: AppStore? = null
        private set

    private val bg = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onCreate() {
        super.onCreate()
        Notifier.ensureChannel(this)
        sessions = SessionStore(this)
        ntfy = NtfyClient { title, body ->
            Notifier.post(this, title, body, runId = null)
        }
    }

    /** (Re)build the store — e.g. after logout or when the activity starts fresh. */
    fun ensureStore(): AppStore {
        val existing = store
        if (existing != null) {
            existing.boot()
            return existing
        }
        val created = AppStore(sessions, onNotify = { notification ->
            Notifier.post(this, notification.title, notification.body, notification.runId)
        })
        store = created
        created.boot()
        return created
    }

    fun dropStore() {
        store = null
    }

    /** Persist + (de)activate the ntfy push subscription (ADR-009: self-hosted ntfy). */
    fun setNtfy(url: String?, topic: String?, enabled: Boolean) {
        bg.launch {
            val info = sessions.read() ?: return@launch
            sessions.save(
                info.copy(ntfyUrl = url?.takeIf { enabled && it.isNotBlank() }, ntfyTopic = topic?.takeIf { enabled && it.isNotBlank() }),
            )
            val u = url?.takeIf { enabled && it.isNotBlank() }
            val t = topic?.takeIf { enabled && it.isNotBlank() }
            if (u != null && t != null) ntfy.start(u, t) else ntfy.stop()
        }
    }

    /** Resume a persisted ntfy subscription on cold start. */
    fun resumeNtfy() {
        bg.launch {
            val info = sessions.read() ?: return@launch
            val u = info.ntfyUrl
            val t = info.ntfyTopic
            if (u != null && t != null) ntfy.start(u, t)
        }
    }

    companion object {
        fun of(context: Context): FoundryApp = context.applicationContext as FoundryApp
    }
}