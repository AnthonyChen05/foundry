package app.foundry.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.padding
import app.foundry.android.core.FoundryError
import app.foundry.android.core.str
import app.foundry.android.data.AppState
import app.foundry.android.data.AppStore
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * PTY terminal (§4): term.open (server reuses the env's live session and
 * replays scrollback), term.data events via the store's terminal state,
 * term.input to type, term.close on dispose.
 */
@Composable
fun TermScreen(store: AppStore, state: AppState, chatId: String) {
    val scope = rememberCoroutineScope()
    val binding = store.chatById(chatId)
    val envId = binding?.envId

    var termId by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf("") }
    var input by remember { mutableStateOf("") }
    val sock = store.socketOrNull()

    LaunchedEffect(chatId) {
        if (sock == null) {
            error = "not connected"
            return@LaunchedEffect
        }
        try {
            val params = if (envId != null) {
                buildJsonObject { put("envId", envId) }
            } else {
                buildJsonObject { }
            }
            val payload = sock.request("term.open", params, idem = store.idem("term")) ?: return@LaunchedEffect
            val opened = payload.str("termId") ?: return@LaunchedEffect
            termId = opened
            val replay = payload.str("replay") ?: ""
            if (replay.isNotEmpty()) store.seedTerminal(opened, replay)
        } catch (err: FoundryError) {
            error = err.message ?: "term.open failed"
        }
    }

    DisposableEffect(termId) {
        val id = termId
        onDispose {
            if (id != null && sock != null) {
                scope.launch {
                    runCatching {
                        sock.request("term.close", buildJsonObject { put("termId", id) }, idem = store.idem("term-close"))
                    }
                    store.forgetTerminal(id)
                }
            }
        }
    }

    val session = termId?.let { state.terminal[it] }

    Column(Modifier.fillMaxSize().imePadding()) {
        if (error.isNotBlank()) {
            Text(error, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(12.dp))
            return@Column
        }
        if (session?.exit != null) {
            Text(
                "session ended (code ${session.exit})",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(8.dp),
            )
        }
        Text(
            sessionText(state, termId),
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(12.dp),
        )
        Row(
            Modifier.fillMaxWidth().padding(8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        ) {
            OutlinedTextField(
                value = input,
                onValueChange = { input = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("command…") },
                singleLine = true,
            )
            IconButton(
                onClick = {
                    val id = termId
                    val data = input
                    if (id == null || sock == null || data.isEmpty()) return@IconButton
                    input = ""
                    scope.launch {
                        runCatching {
                            sock.request(
                                "term.input",
                                buildJsonObject { put("termId", id); put("data", "$data\n") },
                                idem = store.idem("term-input"),
                            )
                        }
                    }
                },
            ) {
                Icon(Icons.Filled.Send, contentDescription = "Run")
            }
        }
    }
}

private fun sessionText(state: AppState, termId: String?): String {
    val text = state.terminal[termId]?.text ?: ""
    if (text.length > 8_000) return "…\n" + text.takeLast(8_000)
    return text
}