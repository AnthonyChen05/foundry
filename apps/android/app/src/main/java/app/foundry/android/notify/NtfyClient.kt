package app.foundry.android.notify

import app.foundry.android.core.str
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * Streaming subscription to a self-hosted ntfy topic (ADR-009): long-poll
 * `GET {url}/{topic}/json` and surface each `event:"message"` line as a
 * notification. Runs while the app process lives; when the process is dead,
 * delivery falls back to the ntfy Android app subscribed to the same topic.
 */
class NtfyClient(private val onMessage: (title: String, body: String) -> Unit) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // stream indefinitely
        .build()
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private var job: Job? = null
    private var call: okhttp3.Call? = null

    fun start(url: String, topic: String) {
        stop()
        job = CoroutineScope(Dispatchers.IO).launch {
            val normalized = url.trimEnd('/')
            while (true) {
                try {
                    val request = Request.Builder().url("$normalized/$topic/json").build()
                    val newCall = client.newCall(request)
                    call = newCall
                    newCall.execute().use { res ->
                        if (!res.isSuccessful) {
                            kotlinx.coroutines.delay(10_000) // server down / bad topic — retry
                            return@use
                        }
                        val source = res.body?.source() ?: return@use
                        while (true) {
                            val line = source.readUtf8Line() ?: break
                            val obj = runCatching { json.parseToJsonElement(line) }.getOrNull() ?: continue
                            val event = obj.str("event") ?: continue
                            if (event != "message") continue
                            onMessage(obj.str("title") ?: "", obj.str("message") ?: "")
                        }
                    }
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // stream dropped (network change or stop()) — reconnect after a beat
                }
                kotlinx.coroutines.delay(2_000)
            }
        }
    }

    fun stop() {
        call?.cancel()
        call = null
        job?.cancel()
        job = null
    }
}