package app.foundry.android.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/**
 * Typed mirrors of protocol.md §3 core shapes (normative). Parsed with
 * `ignoreUnknownKeys` so additive protocol fields never break the client.
 */

@Serializable
data class ChatSummary(
    val id: String,
    val title: String,
    val model: String? = null,
    /** ADR-015 execution binding. */
    val location: String? = null,
    val envId: String? = null,
    val createdAt: String,
    val updatedAt: String,
)

/**
 * Canonical OpenAI message. `content` is usually a string; parts-arrays are
 * kept as raw JSON and flattened for display only.
 */
@Serializable
data class Message(
    val id: String? = null,
    val seq: Long? = null,
    val role: String,
    val content: JsonElement? = null,
    val toolCalls: List<ToolCall>? = null,
    val toolCallId: String? = null,
    val name: String? = null,
) {
    /** Display text: string content, or a best-effort JSON rendering of parts. */
    val displayText: String
        get() = when (content) {
            null -> ""
            is JsonPrimitive -> content.content
            else -> content.toString()
        }
}

@Serializable
data class ToolCall(
    val id: String,
    @kotlinx.serialization.SerialName("type") val callType: String? = null,
    val function: ToolCallFunction? = null,
)

@Serializable
data class ToolCallFunction(val name: String, val arguments: String? = null)

@Serializable
data class Run(
    val id: String,
    val conversationId: String? = null,
    val trigger: String,
    val status: String,
    val model: String,
    val budgets: Budgets,
    val createdAt: String,
    val startedAt: String? = null,
    val endedAt: String? = null,
    val summary: String? = null,
    val error: String? = null,
    /** Ride-along open gates (run.get only). */
    val gates: List<Gate>? = null,
)

@Serializable
data class Budgets(
    val maxSteps: Int,
    val maxTokens: Int,
    val maxCostUsd: Double,
    val maxWallMs: Long,
)

/** Gates rows ARE the truth. */
@Serializable
data class Gate(
    val gateId: String,
    val runId: String,
    val tool: String,
    val args: JsonElement? = null,
    val policy: String? = null,
    val state: String? = null,
    val resolvedBy: String? = null,
    val createdAt: String,
    val resolvedAt: String? = null,
)

/** Replayed run_events row. runEvents(runId, since) → items sorted by seq. */
@Serializable
data class RunEventItem(
    val seq: Long,
    val type: String,
    val payload: JsonElement? = null,
    val createdAt: String = "",
)

@Serializable
data class Model(
    val id: String,
    val provider: String,
    val name: String,
    val caps: ModelCaps? = null,
    val context: Int? = null,
    val enabled: Boolean = true,
)

@Serializable
data class ModelCaps(
    val vision: Boolean = false,
    val tools: Boolean = false,
    val reasoning: Boolean = false,
    val json: Boolean = false,
)

@Serializable
data class FileEntry(
    val path: String,
    val size: Long = 0,
    val mtime: String = "",
    val isDir: Boolean = false,
)

/** Executor presence probe (ADR-015); undefined dockerAvailable = unknown. */
@Serializable
data class ExecutorInfo(
    val online: Boolean = false,
    val name: String? = null,
    val version: String? = null,
    val dockerAvailable: Boolean? = null,
    val workspaceRoot: String? = null,
    val reason: String? = null,
)

@Serializable
data class TermOpenResult(val termId: String, val envId: String? = null, val replay: String? = null)

@Serializable
data class ConnectResult(
    val sessionId: String,
    val protocol: Int,
    val features: Features? = null,
) {
    @Serializable
    data class Features(val methods: List<String> = emptyList(), val events: List<String> = emptyList())
}

/** auth.login (ADR-014) → 30-day session. */
data class Session(val sessionToken: String, val expiresAt: String)

/** ChatSend / run.cancel results and login share `{ runId }`-ish minimal reads. */
fun runIdOf(payload: JsonElement?): String = payload?.str("runId") ?: ""

/** Extract text of a tool_call event payload (`{ call: { id, name, args } }`). */
data class ToolCallEvent(val id: String, val name: String, val args: JsonElement?)

fun toolCallEventOf(payload: JsonElement?): ToolCallEvent? {
    val call = payload?.obj("call") ?: return null
    return ToolCallEvent(id = call.str("id") ?: "", name = call.str("name") ?: "", args = call["args"])
}