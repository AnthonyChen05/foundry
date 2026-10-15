package app.foundry.android.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/** protocol.md §5: additive changes only within a version. */
const val PROTOCOL_VERSION = 0

/** §1.3: methods that mutate state require `idem` on the frame itself. */
val IDEMPOTENT_METHODS =
    setOf(
        "chat.send", "run.cancel", "run.approve", "term.open", "term.input",
        "term.resize", "term.close", "files.write", "files.mkdir", "files.rm",
    )

/** ProtocolError (§1.1). */
data class FoundryError(
    val code: String,
    override val message: String,
    val retryable: Boolean = false,
) : Exception(message)

/** Normalized server push frame (§1.1). */
data class FoundryEvent(
    val event: String,
    val channel: String,
    val seq: Int,
    val payload: JsonElement?,
)

/** Normalized server→client request (executor plane — the desktop runner answers these; this client never does). */
data class ServerRequest(val id: String, val method: String, val params: JsonElement?)

/** `chat:{id}` → id; other channel forms → "". */
fun chatOf(channel: String): String = if (channel.startsWith("chat:")) channel.removePrefix("chat:") else ""

/** `run:{id}` → id; other channel forms → "". */
fun runOf(channel: String): String = if (channel.startsWith("run:")) channel.removePrefix("run:") else ""

/**
 * Parse any inbound text frame. Only res (correlating a pending id) and event
 * frames are meaningful to a regular client; req frames belong to executor
 * connections, and the server only sends them there.
 */
sealed interface Inbound {
    /** `type:"res"`, correlated by [id]. [isConnect] marks the handshake res (id "connect"). */
    data class Res(val id: String, val ok: Boolean, val payload: JsonElement?, val error: FoundryError?) : Inbound {
        val isConnect: Boolean get() = id == "connect"
    }

    data class Event(val event: FoundryEvent) : Inbound

    /** Executor-plane server→client request — replied with an internal error (this client has no handler). */
    data class Req(val req: ServerRequest) : Inbound
}

fun parseFrame(raw: String): Inbound? = try {
    val obj = Json.parseToJsonElement(raw).jsonObject
    when (obj["type"]?.jsonPrimitive?.contentOrNull) {
        "res" -> {
            val id = obj["id"]?.jsonPrimitive?.contentOrNull ?: return null
            val ok = obj["ok"]?.jsonPrimitive?.booleanOrNull ?: return null
            val err = (obj["error"] as? JsonObject)?.let {
                FoundryError(
                    code = it["code"]?.jsonPrimitive?.contentOrNull ?: "internal",
                    message = it["message"]?.jsonPrimitive?.contentOrNull ?: "request failed",
                    retryable = it["retryable"]?.jsonPrimitive?.booleanOrNull ?: false,
                )
            }
            Inbound.Res(id, ok, obj["payload"], err)
        }

        "event" -> Inbound.Event(
            FoundryEvent(
                event = obj["event"]?.jsonPrimitive?.contentOrNull ?: return null,
                channel = obj["channel"]?.jsonPrimitive?.contentOrNull ?: return null,
                seq = obj["seq"]?.jsonPrimitive?.int ?: return null,
                payload = obj["payload"],
            ),
        )

        "req" -> Inbound.Req(
            ServerRequest(
                id = obj["id"]?.jsonPrimitive?.contentOrNull ?: return null,
                method = obj["method"]?.jsonPrimitive?.contentOrNull ?: return null,
                params = obj["params"],
            ),
        )

        else -> null
    }
} catch (e: Exception) {
    null
}

// ---------------------------------------------------------------------------
// Small payload accessors (typed results are parsed in Wire.kt; these read
// flat event payloads without full models).
// ---------------------------------------------------------------------------

fun JsonElement?.str(field: String): String? =
    (this as? JsonObject)?.get(field)?.jsonPrimitive?.contentOrNull

fun JsonElement?.bool(field: String): Boolean? =
    (this as? JsonObject)?.get(field)?.jsonPrimitive?.booleanOrNull

fun JsonElement?.long(field: String): Long? =
    (this as? JsonObject)?.get(field)?.jsonPrimitive?.longOrNull

fun JsonElement?.array(field: String): List<JsonElement> =
    (this as? JsonObject)?.get(field)?.jsonArray ?: emptyList()

fun JsonElement?.obj(field: String): JsonObject? = (this as? JsonObject)?.get(field) as? JsonObject

/** String field access on a JsonObject. */
fun JsonObject.str(field: String): String? = this[field]?.jsonPrimitive?.contentOrNull