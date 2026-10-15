package app.foundry.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import app.foundry.android.core.bool
import app.foundry.android.core.long
import app.foundry.android.core.obj
import app.foundry.android.core.RunEventItem
import app.foundry.android.core.ToolCallEvent
import app.foundry.android.core.str
import app.foundry.android.core.toolCallEventOf
import app.foundry.android.data.AppState
import app.foundry.android.data.AppStore
import app.foundry.android.data.LiveEvent

/**
 * Run timeline: replayed run_events + live rows pre-replay (§1.4), gate
 * resolution, cancel. Same merge logic as the web RunTimeline.
 */
@Composable
fun TimelineScreen(store: AppStore, state: AppState, runId: String) {
    run {
        val run = state.runs[runId]
        val rows = store.timelineFor(runId)
        LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp)) {
            item {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        "Run ${runId.take(8)}…",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    if (run != null) {
                        Text(
                            "status: ${run.status}" + (run.error?.let { " · $it" } ?: "") +
                                (run.summary?.let { " · $it" } ?: ""),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (run != null && run.status in listOf("queued", "running", "waiting_approval")) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(onClick = { store.cancelRun(runId) }) { Text("Cancel run") }
                        }
                    }
                    store.gatesFor(runId).forEach { gate ->
                        GateCard(
                            gate,
                            onApprove = { scopeVal -> store.resolveGate(runId, gate.gateId, true, scopeVal) },
                            onDeny = { store.resolveGate(runId, gate.gateId, false, "once") },
                        )
                    }
                    Spacer(Modifier.padding(vertical = 4.dp))
                }
            }
            items(rows, key = ::timelineKey) { row ->
                TimelineRow(row)
            }
            if (rows.isEmpty()) {
                item {
                    Text(
                        "No events yet — deltas and tool calls appear live.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

private fun timelineKey(row: Any): String = when (row) {
    is RunEventItem -> "e${row.seq}-${row.type}"
    is LiveEvent -> "l${row.seq}-${row.type}"
    else -> row.hashCode().toString()
}

@Composable
private fun TimelineRow(row: Any) {
    val live = row is LiveEvent
    when (row) {
        is RunEventItem -> Describe(run = row.type, payload = row.payload, live = false)
        is LiveEvent -> Describe(run = row.type, payload = row.payload, live = true)
    }
}

@Composable
private fun Describe(run: String, payload: kotlinx.serialization.json.JsonElement?, live: Boolean) {
    val body = when (run) {
        "run.tool_call" -> {
            val call: ToolCallEvent? = toolCallEventOf(payload)
            call?.let { "⚙ ${it.name} ${it.args?.toString()?.take(300) ?: ""}" } ?: "⚙ tool call"
        }
        "run.tool_result" -> {
            val ok = payload?.bool("ok") == true
            "${if (ok) "✓" else "✗"} ${payload?.str("content")?.take(400) ?: ""}"
        }
        "run.usage" -> "tokens ${payload?.long("promptTokens") ?: "?"}/${payload?.long("completionTokens") ?: "?"} ${payload?.str("costEst")?.let { "· \$$it" } ?: ""}"
        "chat.delta" -> "Δ ${payload?.str("delta")?.take(200) ?: ""}"
        "run.gate_request" -> "gate: ${payload?.str("tool") ?: "?"}"
        "run.gate_resolved" -> "gate resolved: ${payload?.str("state").orEmpty()} (${payload?.str("scope").orEmpty()})"
        else -> run
    }
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        Column {
            AssistChip(onClick = {}, label = { Text(if (live) "● $run" else run, style = MaterialTheme.typography.labelSmall) })
            Text(
                body,
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}