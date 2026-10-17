package app.foundry.android.data

import app.foundry.android.core.ChatSummary
import app.foundry.android.core.FoundryError
import app.foundry.android.core.FoundryEvent
import app.foundry.android.core.Gate
import app.foundry.android.core.Model
import app.foundry.android.core.ExecutorInfo
import app.foundry.android.core.Message
import app.foundry.android.core.Run
import app.foundry.android.core.RunEventItem
import app.foundry.android.core.bool
import app.foundry.android.core.chatOf
import app.foundry.android.core.long
import app.foundry.android.core.obj
import app.foundry.android.core.runIdOf
import app.foundry.android.core.runOf
import app.foundry.android.core.str
import app.foundry.android.core.toolCallEventOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.util.UUID

/** Connection status incl. the store-only "not connected yet". */
enum class Conn { OFFLINE, CONNECTING, OPEN, RECONNECTING, CLOSED }

enum class Phase { BOOT, LOGIN, READY }

/** A live (still streaming) run's text, keyed by runId. */
data class Draft(val chatId: String, val text: String)

/** Live-but-not-yet-replayed timeline item (until the full refetch). */
data class LiveEvent(val seq: Int, val type: String, val payload: JsonElement?, val createdAt: String, val live: Boolean = true)

data class UiNotification(val title: String, val body: String, val runId: String? = null, val at: Long)

/** Live PTY session state (§4 Terminal wire): scrollback + exit code. */
data class TermSession(val text: String = "", val exit: Int? = null)

/** Tool-policy row for the composer. */
data class ToolPolicyRow(val tool: String, val policy: String)

/**
 * The Android client's single view state over the server-authoritative
 * backend (CLAUDE.md): commands go out, the store mirrors what events and
 * refetches say, and sys.resync triggers a refetch — no local truth. This is
 * the StateFlow port of apps/web's foundry.svelte.ts.
 */
data class AppState(
    val phase: Phase = Phase.BOOT,
    val conn: Conn = Conn.OFFLINE,
    val connError: String = "",
    val serverUrl: String = "",
    val username: String = "",

    val chats: List<ChatSummary> = emptyList(),
    val activeChatId: String = "",

    /** chatId → messages (canonical OpenAI messages, server truth). */
    val messages: Map<String, List<Message>> = emptyMap(),
    /** runId → streaming draft. */
    val drafts: Map<String, Draft> = emptyMap(),

    /** runId → run info (stubs ok; full on run.get). */
    val runs: Map<String, Run> = emptyMap(),
    /** runId → open gates. */
    val gates: Map<String, List<Gate>> = emptyMap(),
    /** runId → replayed run_events. */
    val events: Map<String, List<RunEventItem>> = emptyMap(),
    /** runId → live items not yet covered by a replay. */
    val live: Map<String, List<LiveEvent>> = emptyMap(),
    /** runIds in first-seen order (newest last). */
    val runOrder: List<String> = emptyList(),
    val selectedRunId: String = "",

    val notifications: List<UiNotification> = emptyList(),
    val models: List<Model> = emptyList(),

    /** Executor presence (ADR-015): null = not yet probed; online=false = no local sandbox. */
    val executor: ExecutorInfo? = null,

    /** termId → live terminal session (term.data/term.exit events + replay). */
    val terminal: Map<String, TermSession> = emptyMap(),
)

/**
 * One login session's store: owns the socket + session scope. Instantiate a
 * fresh AppStore per login (MainActivity keeps the current one).
 */
class AppStore(
    private val sessions: SessionStore,
    private val onNotify: ((UiNotification) -> Unit)? = null,
) {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private val _state = MutableStateFlow(AppState())
    val state: StateFlow<AppState> = _state.asStateFlow()

    private var scope: CoroutineScope? = null
    private var socket: FoundrySocket? = null
    private var rest: FoundryRest? = null
    private var token: String? = null

    // -----------------------------------------------------------------------
    // boot / login / logout
    // -----------------------------------------------------------------------

    /** Cold start: if a persisted session exists, reconnect with it. */
    fun boot() {
        val prev = socket
        val prevScope = scope
        val start = _state.value.copy(phase = Phase.BOOT)
        _state.value = start
        scope?.cancel()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val s = scope!!
        s.launch {
            // Tear down any previous session's transport first.
            prev?.close()
            prevScope?.cancel()
            bootIn(s)
        }
    }

    private suspend fun bootIn(s: CoroutineScope) {
        val info = sessions.read()
        if (info == null || info.token == null || info.serverUrl.isEmpty()) {
            _state.update { it.copy(phase = Phase.LOGIN, serverUrl = info?.serverUrl ?: "", username = info?.username ?: "") }
            return
        }
        _state.update { it.copy(serverUrl = info.serverUrl, username = info.username ?: "") }
        connectIn(s, info.serverUrl, info.token)
    }

    suspend fun loginWithPassword(serverUrl: String, username: String, password: String) {
        val base = normalizeUrl(serverUrl)
        val r = FoundryRest(base)
        val session = try {
            r.login(username, password)
        } catch (err: FoundryError) {
            _state.update { it.copy(connError = err.message ?: "login failed") }
            return
        }
        sessions.save(
            SessionInfo(serverUrl = base, token = session.sessionToken, username = username, ntfyUrl = null, ntfyTopic = null),
        )
        connectIn(scope!!, base, session.sessionToken)
    }

    fun logout() {
        socket?.close()
        socket = null
        rest = null
        scope?.cancel()
        scope = null
        token = null
        _state.value = AppState(phase = Phase.LOGIN, serverUrl = _state.value.serverUrl, username = _state.value.username)
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        scope!!.launch { sessions.clearToken() }
    }

    /** Drop + re-open the socket (settings "Reconnect" button). */
    fun reconnect() {
        val s = scope ?: return
        val url = _state.value.serverUrl
        val t = token ?: return
        socket?.close()
        socket = null
        s.launch { connectIn(s, url, t) }
    }

    private fun normalizeUrl(raw: String): String {
        val trimmed = raw.trim()
        return if (trimmed.startsWith("http", ignoreCase = true)) trimmed else "http://$trimmed"
    }

    private suspend fun connectIn(s: CoroutineScope, serverUrl: String, token: String) {
        this.token = token
        rest = FoundryRest(serverUrl)
        val sock = FoundrySocket(s, serverUrl, token, clientKind = "android", clientVersion = "0.1.0")
        sock.onStatus = { status, err ->
            _state.update {
                it.copy(
                    conn = Conn.valueOf(status.name),
                    connError = err?.message ?: (if (status == SocketStatus.OPEN) "" else it.connError),
                )
            }
        }
        sock.onResync = { channel -> refetchChannel(channel) }
        sock.onEvent = { event -> handleEvent(event) }
        socket = sock
        try {
            sock.connect()
        } catch (err: Exception) {
            val f = err as? FoundryError ?: FoundryError("internal", err.message ?: "connect failed")
            if (f.code == "unauthorized") {
                // Stale or revoked token: forget it, go back to the login gate.
                sessions.clearToken()
                socket = null
                _state.update { it.copy(conn = Conn.OFFLINE, phase = Phase.LOGIN) }
            } else {
                _state.update { it.copy(connError = f.message ?: "connect failed", phase = Phase.LOGIN) }
            }
            return
        }
        _state.update { it.copy(phase = Phase.READY) }
        s.launch {
            refreshChats()
            refreshModels()
            // Executor presence (ADR-015): probe once; updates arrive via the event.
            val exec = runCatching { sock.request("exec.status", buildJsonObject { }) }.getOrNull()
            _state.update {
                it.copy(
                    executor = if (exec != null) {
                        runCatching { json.decodeFromJsonElement(ExecutorInfo.serializer(), exec) }.getOrNull()
                    } else {
                        ExecutorInfo(online = false)
                    },
                )
            }
        }
    }

    /** Access the socket for screens that talk to it directly (term, files). */
    fun socketOrNull(): FoundrySocket? = socket
    fun currentToken(): String? = token
    fun restOrNull(): FoundryRest? = rest

    fun idem(prefix: String): String = "${prefix}-${UUID.randomUUID()}"

    // -----------------------------------------------------------------------
    // event intake (runs on the socket's reader thread — updates are atomic)
    // -----------------------------------------------------------------------

    private fun handleEvent(event: FoundryEvent) {
        android.util.Log.i("Foundry", "event: ${event.event} ${event.channel} seq=${event.seq}")
        val p = event.payload
        when (event.event) {
            "chat.delta" -> {
                // Flat payload per protocol.md §1.4: { runId, delta }.
                val runId = p.str("runId") ?: ""
                val delta = p.str("delta") ?: ""
                if (runId.isEmpty() || delta.isEmpty()) return
                val chatId = chatOf(event.channel)
                _state.update { st ->
                    val draft = st.drafts[runId]
                    val drafts = if (draft == null) {
                        if (chatId.isEmpty()) st.drafts else st.drafts + (runId to Draft(chatId, delta))
                    } else {
                        st.drafts + (runId to Draft(draft.chatId, draft.text + delta))
                    }
                    st.copy(drafts = drafts)
                }
            }

            "chat.final" -> {
                val chatId = chatOf(event.channel)
                val message = p?.obj("message")?.let { raw ->
                    runCatching { json.decodeFromJsonElement(Message.serializer(), raw) }.getOrNull()
                }
                _state.update { st ->
                    val messages = if (message != null && chatId.isNotEmpty()) {
                        val list = st.messages[chatId] ?: emptyList()
                        st.messages + (chatId to list + message)
                    } else {
                        st.messages
                    }
                    val drafts = st.drafts.filterValues { it.chatId != chatId }
                    st.copy(messages = messages, drafts = drafts)
                }
            }

            "run.status" -> {
                val runId = p.str("runId") ?: ""
                val status = p.str("status") ?: ""
                if (runId.isEmpty() || status.isEmpty()) return
                noteRun(runId)
                val errorMsg = p.str("error")
                _state.update { st ->
                    val run = st.runs[runId]
                    val runs = if (run == null) {
                        st.runs + (runId to stubRun(runId, status, errorMsg))
                    } else {
                        st.runs + (runId to run.copy(status = status, error = errorMsg))
                    }
                    st.copy(runs = runs)
                }
                when (status) {
                    "waiting_approval" -> refreshRun(runId)
                    "done", "failed", "cancelled", "timeout" -> {
                        // Terminal state: replace optimistic live items with server truth.
                        _state.update { st -> st.copy(drafts = st.drafts - runId) }
                        refreshRunEvents(runId)
                    }
                }
            }

            "run.gate_request" -> {
                // Payload IS the §3 Gate shape plus state omitted (flat, no gate: wrapper).
                val gate = p?.let { raw ->
                    runCatching {
                        json.decodeFromJsonElement(Gate.serializer(), raw.addMissingState())
                    }.getOrNull()
                }
                val runId = p?.str("runId") ?: ""
                val gateId = p?.str("gateId") ?: ""
                if (gate == null || runId.isEmpty() || gateId.isEmpty()) return
                noteRun(runId)
                addLive(runId, event)
                _state.update { st ->
                    val list = st.gates[runId] ?: emptyList()
                    st.copy(
                        gates = if (list.none { it.gateId == gateId }) st.gates + (runId to (list + gate)) else st.gates,
                    )
                }
            }

            "run.gate_resolved" -> {
                val runId = runOf(event.channel)
                val gateId = p.str("gateId") ?: ""
                if (runId.isEmpty()) return
                addLive(runId, event)
                if (gateId.isNotEmpty()) {
                    _state.update { st ->
                        val list = st.gates[runId]?.filter { it.gateId != gateId } ?: return@update st
                        if (list.isEmpty()) st.copy(gates = st.gates - runId)
                        else st.copy(gates = st.gates + (runId to list))
                    }
                }
            }

            "run.tool_call", "run.tool_result", "run.usage" -> {
                val runId = runOf(event.channel)
                if (runId.isEmpty()) return
                noteRun(runId)
                addLive(runId, event)
            }

            "notify.push" -> {
                val n = UiNotification(
                    title = p.str("title") ?: "",
                    body = p.str("body") ?: "",
                    runId = p.str("runId"),
                    at = System.currentTimeMillis(),
                )
                _state.update { st ->
                    val list = st.notifications + n
                    st.copy(notifications = if (list.size > 20) list.drop(1) else list)
                }
                onNotify?.invoke(n)
            }

            "executor.status" -> {
                // ADR-015: the desktop runner registered or dropped. Payload = ExecutorInfo.
                _state.update { st ->
                    val info = p?.let { raw ->
                        runCatching { json.decodeFromJsonElement(ExecutorInfo.serializer(), raw) }.getOrNull()
                    }
                    st.copy(executor = info)
                }
            }

            "term.data" -> {
                // §4: terminal bytes as text, or base64; channel term:{termId}.
                val termId = runOf(event.channel)
                val data = p.str("data") ?: ""
                if (termId.isEmpty() || data.isEmpty()) return
                val text = if (p.bool("b64") == true) {
                    runCatching { String(java.util.Base64.getDecoder().decode(data), Charsets.UTF_8) }.getOrNull() ?: ""
                } else {
                    data
                }
                _state.update { st ->
                    val session = st.terminal[termId] ?: TermSession()
                    val next = session.copy(text = (session.text + text).takeLast(100_000))
                    st.copy(terminal = st.terminal + (termId to next))
                }
            }

            "term.exit" -> {
                val termId = runOf(event.channel)
                if (termId.isEmpty()) return
                _state.update { st ->
                    val session = st.terminal[termId] ?: TermSession()
                    st.copy(terminal = st.terminal + (termId to session.copy(exit = p.long("code")?.toInt())))
                }
            }
        }
    }

    // The gate_request payload omits `state` (open by definition); fill it so the strict shape parses.
    private fun JsonElement.addMissingState(): JsonElement {
        val obj = this as? kotlinx.serialization.json.JsonObject ?: return this
        return if ("state" in obj) obj else kotlinx.serialization.json.JsonObject(obj + ("state" to kotlinx.serialization.json.JsonPrimitive("open")))
    }

    private fun stubRun(id: String, status: String, error: String?): Run = Run(
        id = id,
        trigger = "chat",
        status = status,
        model = "",
        budgets = app.foundry.android.core.Budgets(0, 0, 0.0, 0),
        createdAt = java.time.Instant.now().toString(),
        error = error,
    )

    private fun noteRun(runId: String) {
        _state.update { st ->
            val runOrder = if (runId in st.runOrder) st.runOrder else st.runOrder + runId
            // Auto-follow: the timeline shows the newest run of the active chat.
            val run = st.runs[runId]
            val chatId = run?.conversationId
            val selected = if (st.selectedRunId.isEmpty() && (chatId == null || chatId == st.activeChatId)) runId else st.selectedRunId
            st.copy(runOrder = runOrder, selectedRunId = selected)
        }
    }

    private fun addLive(runId: String, event: FoundryEvent) {
        _state.update { st ->
            val list = st.live[runId] ?: emptyList()
            val next = list + LiveEvent(event.seq, event.event, event.payload, java.time.Instant.now().toString())
            st.copy(live = st.live + (runId to (if (next.size > 400) next.drop(1) else next)))
        }
    }

    // -----------------------------------------------------------------------
    // refetches (sys.resync + event-driven)
    // -----------------------------------------------------------------------

    private fun refetchChannel(channel: String) {
        val s = scope ?: return
        when {
            channel.startsWith("chat:") -> {
                val chatId = chatOf(channel)
                s.launch {
                    refreshChats()
                    if (chatId.isNotEmpty() && _state.value.messages[chatId] != null) refreshMessages(chatId)
                }
            }
            channel.startsWith("run:") -> {
                val runId = runOf(channel)
                s.launch {
                    refreshRun(runId)
                    refreshRunEvents(runId)
                }
            }
        }
    }

    fun refreshChats() {
        val s = scope ?: return
        s.launch {
            try {
                socket?.request("chat.list", null)?.let { payload ->
                    val chats = decodeArray(payload, ChatSummary.serializer())
                    _state.update { it.copy(chats = chats) }
                }
            } catch (err: FoundryError) {
                _state.update { it.copy(connError = err.message ?: "chat.list failed") }
            }
        }
    }

    private suspend fun refreshModels() {
        try {
            socket?.request("sys.models", null)?.let { payload ->
                val models = decodeArray(payload, Model.serializer())
                _state.update { it.copy(models = models) }
            }
        } catch (err: FoundryError) {
            // non-fatal: catalog may simply be empty
        }
    }

    fun refreshMessages(chatId: String) {
        val s = scope ?: return
        s.launch {
            try {
                socket?.request("chat.history", buildJsonObject { put("chatId", chatId) })?.let { payload ->
                    val list = decodeArray(payload, Message.serializer())
                    _state.update { it.copy(messages = it.messages + (chatId to list)) }
                }
            } catch (err: FoundryError) {
                _state.update { it.copy(connError = err.message ?: "history failed") }
            }
        }
    }

    private fun refreshRun(runId: String) {
        val s = scope ?: return
        s.launch {
            try {
                socket?.request("run.get", buildJsonObject { put("runId", runId) })?.let { payload ->
                    val run = runCatching { json.decodeFromJsonElement(Run.serializer(), payload) }.getOrNull() ?: return@launch
                    _state.update { st ->
                        val gates = if (run.gates.isNullOrEmpty()) {
                            if (st.gates[runId]?.isNotEmpty() == true) st.gates - runId else st.gates
                        } else {
                            st.gates + (runId to run.gates)
                        }
                        st.copy(runs = st.runs + (runId to run), gates = gates)
                    }
                    val chatId = run.conversationId
                    if (!chatId.isNullOrEmpty() && _state.value.messages[chatId] != null) refreshMessages(chatId)
                }
            } catch (err: FoundryError) {
                // run may not exist yet on a stub — non-fatal
            }
        }
    }

    private fun refreshRunEvents(runId: String) {
        val s = scope ?: return
        s.launch {
            try {
                socket?.request("run.events", buildJsonObject {
                    put("runId", runId)
                    put("since", 0L)
                })?.let { payload ->
                    val items = decodeArray(payload, RunEventItem.serializer())
                    _state.update { st -> st.copy(events = st.events + (runId to items), live = st.live - runId) }
                }
            } catch (err: FoundryError) {
                // run may not be visible yet — live frames still show
            }
        }
    }

    private fun <T> decodeArray(payload: JsonElement, serializer: kotlinx.serialization.KSerializer<T>): List<T> {
        val arr = payload as? kotlinx.serialization.json.JsonArray ?: return emptyList()
        return arr.mapNotNull { el ->
            runCatching { json.decodeFromJsonElement(serializer, el) }.getOrNull()
        }
    }

    /** Decode one FileEntry row for the files screen. */
    fun decodeFileEntry(el: JsonElement): app.foundry.android.core.FileEntry =
        json.decodeFromJsonElement(app.foundry.android.core.FileEntry.serializer(), el)

    // -----------------------------------------------------------------------
    // commands
    // -----------------------------------------------------------------------

    fun selectChat(chatId: String) {
        _state.update { it.copy(activeChatId = chatId) }
        if (_state.value.messages[chatId] == null) refreshMessages(chatId)
    }

    /** Notification tap-through: bring a run to the front. */
    fun focusRun(runId: String) {
        _state.update { st ->
            val runOrder = if (runId in st.runOrder) st.runOrder else st.runOrder + runId
            st.copy(runOrder = runOrder, selectedRunId = runId)
        }
    }

    /** Drop a terminal session from state (screen dispose / closed PTY). */
    fun forgetTerminal(termId: String) {
        _state.update { it.copy(terminal = it.terminal - termId) }
    }

    /** Seed scrollback from term.open's replay (§4). */
    fun seedTerminal(termId: String, replay: String) {
        _state.update { st -> st.copy(terminal = st.terminal + (termId to (st.terminal[termId] ?: TermSession()).copy(text = replay))) }
    }

    fun createChat(title: String?) {
        val s = scope ?: return
        s.launch {
            try {
                socket?.request(
                    "chat.create",
                    if (title.isNullOrBlank()) buildJsonObject { } else buildJsonObject { put("title", title) },
                    idem("chat-create"),
                )?.let { payload ->
                    val chat = runCatching { json.decodeFromJsonElement(ChatSummary.serializer(), payload) }.getOrNull() ?: return@launch
                    _state.update { st -> st.copy(chats = listOf(chat) + st.chats.filter { it.id != chat.id }) }
                    selectChat(chat.id)
                }
            } catch (err: FoundryError) {
                _state.update { it.copy(connError = err.message ?: "create failed") }
            }
        }
    }

    fun send(chatId: String, content: String, agent: Boolean, policy: List<ToolPolicyRow>, model: String?, location: String?) {
        val s = scope ?: return
        s.launch {
            val params = buildJsonObject {
                put("chatId", chatId)
                put("content", content)
                if (model != null && model.isNotEmpty()) put("model", model)
                if (agent) {
                    putJsonObject("agent") {
                        put("enabled", true)
                        val rows = policy.filter { it.tool.isNotBlank() }
                        if (rows.isNotEmpty()) {
                            putJsonObject("toolPolicy") {
                                rows.forEach { put(it.tool.trim(), it.policy) }
                            }
                        }
                        // ADR-015: location "local" crosses to the desktop executor; the default
                        // cloud omits the field entirely.
                        if (location == "local") put("location", "local")
                    }
                }
            }
            val payload = try {
                socket?.request("chat.send", params, idem = idem("chat"))
            } catch (err: FoundryError) {
                _state.update { it.copy(connError = err.message ?: "send failed") }
                null
            } ?: return@launch
            val runId = runIdOf(payload)
            if (runId.isEmpty()) return@launch
            noteRun(runId)
            _state.update { st ->
                val chat = st.chats.firstOrNull { it.id == chatId }
                st.copy(
                    runs = st.runs + (runId to stubRun(runId, "queued", null).copy(
                        conversationId = chatId,
                        model = model ?: chat?.model ?: "",
                    )),
                    live = st.live + (runId to emptyList()),
                    selectedRunId = runId,
                )
            }
        }
    }

    fun cancelRun(runId: String) {
        if (_state.value.phase != Phase.READY) return
        scope?.launch {
            runCatching { socket?.request("run.cancel", buildJsonObject { put("runId", runId) }, idem("cancel")) }
        }
    }

    fun resolveGate(runId: String, gateId: String, approve: Boolean, scopeStr: String) {
        val s = scope ?: return
        s.launch {
            val params = buildJsonObject {
                put("runId", runId)
                put("gateId", gateId)
                put("approve", approve)
                if (approve && scopeStr != "once") put("scope", scopeStr)
            }
            try {
                socket?.request("run.approve", params, idem("gate"))
            } catch (err: FoundryError) {
                _state.update { it.copy(connError = err.message ?: "approve failed") }
            }
        }
    }

    /** Push the chat's local workspace + deps into a backend env (ADR-015). */
    fun pushChatToCloud(chatId: String) {
        val s = scope ?: return
        val r = rest ?: return
        val t = token ?: return
        s.launch {
            try {
                r.pushChat(t, chatId)
            } catch (err: FoundryError) {
                _state.update { st -> st.copy(notifications = st.notifications + UiNotification("Push to cloud failed", err.message ?: "", null, System.currentTimeMillis())) }
            }
        }
    }

    // -----------------------------------------------------------------------
    // derived views
    // -----------------------------------------------------------------------

    /** (runId, text) of a chat's streaming drafts — web-parity via the drafts map. */
    fun draftsFor(chatId: String): List<Pair<String, String>> =
        _state.value.drafts.entries.filter { it.value.chatId == chatId }.map { it.key to it.value.text }

    fun liveFor(runId: String): List<LiveEvent> = _state.value.live[runId] ?: emptyList()

    fun gatesFor(runId: String): List<Gate> = _state.value.gates[runId] ?: emptyList()

    fun timelineFor(runId: String): List<Any> =
        (_state.value.events[runId] ?: emptyList()) + (_state.value.live[runId] ?: emptyList())

    fun runsOfChat(chatId: String): List<Run> = _state.value.runOrder
        .mapNotNull { _state.value.runs[it] }
        .filter { it.conversationId == chatId }
        .reversed()

    fun chatById(chatId: String): ChatSummary? = _state.value.chats.firstOrNull { it.id == chatId }

    fun toolCallOf(event: FoundryEvent): app.foundry.android.core.ToolCallEvent? = toolCallEventOf(event.payload)
}