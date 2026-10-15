package app.foundry.android.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.Timeline
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import app.foundry.android.data.AppState
import app.foundry.android.data.AppStore
import app.foundry.android.core.Message
import app.foundry.android.core.Run

/**
 * Conversation view: server-truth messages, streaming drafts, gate approval
 * cards, and the run-status row with timeline/term/files entries.
 */
@Composable
fun ChatScreen(
    store: AppStore,
    state: AppState,
    chatId: String,
    onOpenTimeline: (String) -> Unit,
    onOpenTerm: (String) -> Unit,
    onOpenFiles: (String) -> Unit,
) {
    val chatId = if (chatId == "new" || chatId.isEmpty()) {
        state.activeChatId.ifEmpty { state.chats.firstOrNull()?.id ?: "" }
    } else {
        chatId
    }

    if (chatId.isEmpty()) {
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Text("No chats yet — create one first.")
        }
        return
    }

    val messages = state.messages[chatId] ?: emptyList()
    val drafts = state.drafts.values.filter { it.chatId == chatId }
    val latestRun = store.runsOfChat(chatId).firstOrNull()
    val chat = store.chatById(chatId)
    val gates = latestRun?.let { store.gatesFor(it.id) } ?: emptyList()

    var input by remember { mutableStateOf("") }
    var agent by remember { mutableStateOf(true) }
    var location by remember { mutableStateOf<String?>(null) }
    var policyOpen by remember { mutableStateOf(false) }
    var policyRows by remember {
        mutableStateOf(
            listOf(
                app.foundry.android.data.ToolPolicyRow("shell", "ask"),
                app.foundry.android.data.ToolPolicyRow("write_file", "ask"),
                app.foundry.android.data.ToolPolicyRow("read_file", "always"),
            ),
        )
    }
    var modelMenu by remember { mutableStateOf(false) }
    val models = state.models.filter { it.enabled }
    var model by remember { mutableStateOf<String?>(null) }

    val listState = rememberLazyListState()
    LaunchedEffect(messages.size, drafts.size, drafts.sumOf { it.text.length }) {
        if (messages.isNotEmpty() || drafts.isNotEmpty()) {
            listState.animateScrollToItem((messages.size + drafts.size).coerceAtLeast(0))
        }
    }

    Column(Modifier.fillMaxSize()) {
        // Run row: status + quick entries.
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RunStatusText(latestRun)
            Spacer(Modifier.weight(1f))
            IconButton(onClick = { onOpenTerm(chatId) }) {
                Icon(Icons.Filled.Terminal, contentDescription = "Terminal")
            }
            IconButton(onClick = { onOpenFiles(chatId) }) {
                Icon(Icons.Filled.Description, contentDescription = "Files")
            }
            if (latestRun != null) {
                IconButton(onClick = { onOpenTimeline(latestRun.id) }) {
                    Icon(Icons.Filled.Timeline, contentDescription = "Run timeline")
                }
            }
        }
        val bindingLoc = chat?.location
        if (bindingLoc != null) {
            BindingChipRow(bindingLoc, chat?.envId, onPush = { store.pushChatToCloud(chatId) })
        }

        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            items(messages, key = { it.callKey() }) { message ->
                MessageBubble(message)
            }
            items(drafts, key = { "draft-${it.text.hashCode()}-${it.chatId}" }) { draft ->
                DraftBubble(draft.text)
            }
            // Open gates of the latest run render inline for direct resolution.
            val latestRunId = latestRun?.id ?: ""
            items(gates, key = { it.gateId }) { gate ->
                GateCard(
                    gate,
                    onApprove = { scopeVal ->
                        if (latestRunId.isNotEmpty()) store.resolveGate(latestRunId, gate.gateId, true, scopeVal)
                    },
                    onDeny = {
                        if (latestRunId.isNotEmpty()) store.resolveGate(latestRunId, gate.gateId, false, "once")
                    },
                )
            }
        }

        // Composer.
        Column(Modifier.fillMaxWidth().padding(8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                FilterChip(selected = agent, onClick = { agent = !agent }, label = { Text(if (agent) "agent" else "chat") })
                if (models.isNotEmpty()) {
                    Box {
                        AssistChip(onClick = { modelMenu = true }, label = { Text(model ?: "model") })
                        DropdownMenu(expanded = modelMenu, onDismissRequest = { modelMenu = false }) {
                            models.forEach { m ->
                                DropdownMenuItem(
                                    text = { Text(m.name.ifBlank { m.id }) },
                                    onClick = {
                                        model = m.id
                                        modelMenu = false
                                    },
                                )
                            }
                        }
                    }
                }
                if (agent) {
                    val execOnline = state.executor?.online == true
                    FilterChip(
                        selected = location == "local",
                        enabled = execOnline,
                        onClick = { location = if (location == "local") null else "local" },
                        label = { Text(if (execOnline) "local exec" else "local exec (offline)") },
                    )
                    TextButton(onClick = { policyOpen = !policyOpen }) { Text("policy") }
                }
            }
            if (policyOpen && agent) {
                PolicyEditor(policyRows, onChange = { policyRows = it })
            }
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("Message…") },
                    maxLines = 4,
                )
                IconButton(
                    onClick = {
                        val text = input.trim()
                        if (text.isEmpty()) return@IconButton
                        input = ""
                        store.send(chatId, text, agent, policyRows.ifNoneDefault(), model, location)
                    },
                ) {
                    Icon(Icons.Filled.Send, contentDescription = "Send")
                }
            }
        }
    }
}

private fun Message.callKey(): String = "m-${role}-${content?.hashCode() ?: 0}-${toolCallId ?: ""}"

private fun List<app.foundry.android.data.ToolPolicyRow>.ifNoneDefault(): List<app.foundry.android.data.ToolPolicyRow> = this

@Composable
private fun RunStatusText(run: Run?) {
    if (run == null) {
        Text("no runs yet", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    } else {
        val color = when (run.status) {
            "running", "queued" -> MaterialTheme.colorScheme.primary
            "waiting_approval" -> MaterialTheme.colorScheme.tertiary
            "done" -> MaterialTheme.colorScheme.secondary
            else -> MaterialTheme.colorScheme.error
        }
        Text(run.status, style = MaterialTheme.typography.labelMedium, color = color)
    }
}

@Composable
private fun BindingChipRow(location: String, envId: String?, onPush: () -> Unit) {
    Row(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        AssistChip(onClick = {}, label = { Text(if (location == "local") "runs locally" else "runs in cloud env") })
        if (location == "local") {
            AssistChip(onClick = onPush, label = { Text("push to cloud") })
        }
    }
}

@Composable
private fun MessageBubble(message: Message) {
    val isUser = message.role == "user"
    val isTool = message.role == "tool"
    if (isTool) {
        Text(
            "↳ tool ${message.name ?: message.toolCallId ?: ""}: ${message.displayText.take(300)}",
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 8.dp),
        )
        return
    }
    Surface(
        color = when {
            isUser -> MaterialTheme.colorScheme.primaryContainer
            else -> MaterialTheme.colorScheme.surfaceVariant
        },
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp)),
    ) {
        Column(Modifier.padding(10.dp)) {
            message.toolCalls?.forEach { call ->
                Text(
                    "⚙ ${call.function?.name ?: call.id}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(message.displayText.ifBlank { "(empty)" }, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun DraftBubble(text: String) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(10.dp)) {
            Text("", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(text, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

/** §3 Gate card: tool + args + policy, approvable once/session/always. */
@Composable
fun GateCard(
    gate: app.foundry.android.core.Gate,
    onApprove: (String) -> Unit,
    onDeny: () -> Unit,
) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp)) {
            Text(
                "Approve ${gate.tool}? (${gate.policy ?: "ask"})",
                style = MaterialTheme.typography.titleSmall,
            )
            val args = gate.args?.toString()
            if (!args.isNullOrEmpty() && args != "null") {
                Text(
                    args.take(500),
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { onApprove("once") }) { Text("Approve") }
                TextButton(onClick = { onApprove("session") }) { Text("Session") }
                TextButton(onClick = { onApprove("always") }) { Text("Always") }
                TextButton(onClick = onDeny) { Text("Deny") }
            }
        }
    }
}

@Composable
private fun PolicyEditor(rows: List<app.foundry.android.data.ToolPolicyRow>, onChange: (List<app.foundry.android.data.ToolPolicyRow>) -> Unit) {
    Column(Modifier.padding(vertical = 4.dp)) {
        rows.forEachIndexed { index, row ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().clickable { },
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    row.tool,
                    modifier = Modifier.widthIn(min = 96.dp),
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodySmall,
                )
                listOf("ask", "always", "session", "deny").forEach { policy ->
                    FilterChip(
                        selected = row.policy == policy,
                        onClick = {
                            onChange(
                                rows.toMutableList().also {
                                    it[index] = row.copy(policy = policy)
                                },
                            )
                        },
                        label = { Text(policy, style = MaterialTheme.typography.labelSmall) },
                    )
                }
            }
        }
    }
}