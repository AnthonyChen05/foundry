package app.foundry.android.data

import app.foundry.android.core.ConnectResult
import app.foundry.android.core.FoundryError
import app.foundry.android.core.FoundryEvent
import app.foundry.android.core.Inbound
import app.foundry.android.core.PROTOCOL_VERSION
import app.foundry.android.core.parseFrame
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import kotlinx.serialization.json.putJsonArray
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** SocketStatus; the store layers "OFFLINE" for "not connected yet". */
enum class SocketStatus { CONNECTING, OPEN, RECONNECTING, CLOSED }

/** Per-channel resume cursor (§1.2). */
data class Cursor(val channel: String, val lastSeq: Int)

/**
 * WS `req`/`res`/`event` client over OkHttp — a port of sdk-ts FoundrySocket.
 * Server-authoritative: this class never owns state; it sends commands,
 * delivers events to [onEvent], and routes `sys.resync` to [onResync].
 *
 * Callbacks fire on the OkHttp reader thread — assign them BEFORE [connect]
 * and keep implementations thread-safe (the store uses atomic state updates).
 */
class FoundrySocket(
    private val scope: CoroutineScope,
    baseUrl: String,
    private val token: String,
    private val clientKind: String = "android",
    private val clientVersion: String = "0.1.0",
    private val autoReconnect: Boolean = true,
    private val reconnectMaxMs: Long = 15_000,
) {
    val url: String = baseUrl.replace(Regex("^http"), "ws").trimEnd('/') + "/ws"

    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .build()

    private var ws: WebSocket? = null
    private val nextId = AtomicInteger(1)
    private val pending = ConcurrentHashMap<String, CompletableDeferred<JsonElement?>>()
    private val cursors = ConcurrentHashMap<String, Int>()
    private val connectMutex = Mutex()
    private val reconnectAttempt = AtomicInteger(0)

    var onEvent: ((FoundryEvent) -> Unit)? = null
    var onResync: ((channel: String) -> Unit)? = null
    var onStatus: ((SocketStatus, FoundryError?) -> Unit)? = null

    private var authFailed = false
    private var reconnectJob: Job? = null
    private var handshake: ConnectResult? = null
    /** The in-flight handshake deferred is routed explicitly (socket.ts used pending["connect"]). */
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    val isOpen: Boolean get() = ws != null && handshake != null && !userClosed
    private var userClosed = false

    /** Open + handshake; resumes from the tracked per-channel cursors. */
    suspend fun connect(): ConnectResult = connectMutex.withLock {
        userClosed = false
        authFailed = false
        val resume = cursors.entries.map { Cursor(it.key, it.value) }
        val deferred = CompletableDeferred<ConnectResult>()
        onStatus?.invoke(SocketStatus.CONNECTING, null)
        val request = Request.Builder().url(url).build()

        val socket = client.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    val frame = buildJsonObject {
                        put("type", JsonPrimitive("req"))
                        put("id", JsonPrimitive("connect"))
                        put("method", JsonPrimitive("connect"))
                        put(
                            "params",
                            buildJsonObject {
                                put("protocol", JsonPrimitive(PROTOCOL_VERSION))
                                putJsonObject("auth") { put("token", JsonPrimitive(token)) }
                                putJsonObject("client") {
                                    put("kind", JsonPrimitive(clientKind))
                                    put("version", JsonPrimitive(clientVersion))
                                }
                                putJsonArray("resume") {
                                    resume.forEach { cursor ->
                                        add(buildJsonObject {
                                            put("channel", JsonPrimitive(cursor.channel))
                                            put("lastSeq", JsonPrimitive(cursor.lastSeq))
                                        })
                                    }
                                }
                            },
                        )
                    }
                    webSocket.send(frame.toString())
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    android.util.Log.i("Foundry", "frame: ${text.take(140)}")
                    when (val inbound = parseFrame(text)) {
                        null -> {
                            android.util.Log.w("Foundry", "frame NOT parsed: ${text.take(140)}")
                        }

                        is Inbound.Res -> if (inbound.isConnect) {
                            // Handshake res: ok → decode + complete; failure is
                            // permanent for this socket's fixed token.
                            val decoded = if (inbound.ok) {
                                handshake = inbound.payload?.let { raw ->
                                    runCatching { json.decodeFromJsonElement(ConnectResult.serializer(), raw) }.getOrNull()
                                }
                                handshake
                            } else {
                                authFailed = true
                                null
                            }
                            if (decoded != null) deferred.complete(decoded)
                            else deferred.completeExceptionally(inbound.error ?: FoundryError("internal", "handshake rejected"))
                        } else {
                            routeRes(inbound)
                        }

                        is Inbound.Event -> {
                            cursors[inbound.event.channel] = inbound.event.seq
                            if (inbound.event.event == "sys.resync") {
                                onResync?.invoke(inbound.event.channel)
                            }
                            onEvent?.invoke(inbound.event)
                        }

                        // Executor plane is desktop-runner-only; never happens on this connection.
                        is Inbound.Req -> sendReply(
                            inbound.req.id,
                            ok = false,
                            error = FoundryError("internal", "receiver is not an executor"),
                        )
                    }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    if (webSocket === ws) {
                        // completeExceptionally first so a pending connect() await unblocks.
                        deferred.completeExceptionally(FoundryError("internal", "socket closed: ${t.message ?: t.javaClass.simpleName}"))
                        closed(FoundryError("internal", "socket closed: ${t.message ?: t.javaClass.simpleName}"))
                    }
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (webSocket === ws) {
                        val err = FoundryError("internal", "socket closed ($code${if (reason.isNotEmpty()) ": $reason" else ""})")
                        deferred.completeExceptionally(err)
                        closed(err)
                    }
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    // Let onClosed land; nothing to do.
                }
            },
        )
        ws = socket
        try {
            handshake = deferred.await()
        } finally {
            // Failures after connect() returns (or while waiting) must not keep the stale socket around.
            if (deferred.isCompleted && deferred.isCancelled) ws = null
        }
        reconnectAttempt.set(0)
        onStatus?.invoke(SocketStatus.OPEN, null)
        handshake!!
    }

    private fun closed(err: FoundryError) {
        handshake = null
        ws = null
        for (p in pending.values) p.completeExceptionally(FoundryError(err.code, err.message, err.retryable))
        pending.clear()
        onStatus?.invoke(SocketStatus.CLOSED, err)
        // With a fixed token an auth rejection can never succeed on retry.
        if (!authFailed && !userClosed) scheduleReconnect()
    }

    /** Backoff reconnect: resumes from cursors; callbacks live on this instance. */
    private fun scheduleReconnect() {
        if (!autoReconnect || reconnectJob?.isActive == true || userClosed) return
        val attempt = reconnectAttempt.getAndIncrement()
        // 250ms * 2^attempt + jitter, capped at reconnectMaxMs (integer math —
        // mirrors socket.ts's backoff curve).
        val backoffMs = (250L * (1L shl attempt.coerceAtMost(6)) + (0L..249L).random())
            .coerceAtMost(reconnectMaxMs)
        onStatus?.invoke(SocketStatus.RECONNECTING, null)
        reconnectJob = scope.launch {
            delay(backoffMs)
            if (!userClosed) {
                runCatching { connect() }
            }
        }
    }

    private fun routeRes(res: Inbound.Res) {
        val deferred = pending.remove(res.id) ?: return
        if (res.ok) {
            deferred.complete(res.payload)
        } else {
            deferred.completeExceptionally(res.error ?: FoundryError("internal", "request failed"))
        }
    }

    /** Send a req frame; returns a deferred resolving the res payload. */
    fun req(method: String, params: JsonElement? = null, idem: String? = null, timeoutMs: Long = 60_000): Deferred<JsonElement?> {
        if (!isOpen) {
            val immediate = CompletableDeferred<JsonElement?>()
            immediate.completeExceptionally(FoundryError("internal", "socket not connected"))
            return immediate
        }
        val id = nextId.getAndIncrement().toString(36)
        val deferred = CompletableDeferred<JsonElement?>()
        pending[id] = deferred

        val frame = buildJsonObject {
            put("type", JsonPrimitive("req"))
            put("id", JsonPrimitive(id))
            put("method", JsonPrimitive(method))
            if (params != null) put("params", params)
            if (idem != null) put("idem", JsonPrimitive(idem))
        }
        if (ws?.send(frame.toString()) != true) {
            pending.remove(id)
            val failed = CompletableDeferred<JsonElement?>()
            failed.completeExceptionally(FoundryError("internal", "socket closing"))
            return failed
        }

        // Timeout watcher (capacity-shaped, retryable — mirrors socket.ts).
        val watcher = scope.launch {
            delay(timeoutMs)
            if (pending.remove(id) == deferred) {
                deferred.completeExceptionally(FoundryError("capacity", "timeout waiting for $method response", retryable = true))
            }
        }
        deferred.invokeOnCompletion { watcher.cancel() }
        return deferred
    }

    /** Send a req frame and await its payload (throws FoundryError). */
    suspend fun request(method: String, params: JsonElement? = null, idem: String? = null): JsonElement? =
        suspendCancellableCoroutine { cont ->
            val deferred = req(method, params, idem)
            cont.invokeOnCancellation { /* deferred result simply goes unreceived */ }
            deferred.invokeOnCompletion {
                if (it != null) cont.resumeWithException(it) else cont.resume(deferred.getCompleted())
            }
        }

    private fun sendReply(id: String, ok: Boolean, error: FoundryError? = null) {
        val frame = buildJsonObject {
            put("type", JsonPrimitive("res"))
            put("id", JsonPrimitive(id))
            put("ok", JsonPrimitive(ok))
            if (!ok && error != null) {
                put(
                    "error",
                    buildJsonObject {
                        put("code", JsonPrimitive(error.code))
                        put("message", JsonPrimitive(error.message))
                    },
                )
            }
        }
        try {
            ws?.send(frame.toString())
        } catch (e: Exception) {
            // closing mid-write
        }
    }

    fun close() {
        userClosed = true
        reconnectJob?.cancel()
        reconnectJob = null
        try {
            ws?.close(1000, "client closing")
        } catch (e: Exception) {
            // already closed
        }
        ws = null
        handshake = null
        pending.clear()
    }
}