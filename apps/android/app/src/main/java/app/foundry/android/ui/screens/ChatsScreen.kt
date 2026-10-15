package app.foundry.android.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AssistChip
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Icon
import app.foundry.android.data.AppStore
import app.foundry.android.data.AppState
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/** Chat list (§1.3 chat.list). Model + execution binding (ADR-015) shown as chips. */
@Composable
fun ChatsScreen(store: AppStore, state: AppState, onOpen: (String) -> Unit, onNewChat: () -> Unit) {
    val chats by store.state.collectAsState()
    val formatter = DateTimeFormatter.ofPattern("MM-dd HH:mm")

    Scaffold(
        floatingActionButton = {
            ExtendedFloatingActionButton(onClick = {
                store.createChat(null)
                onNewChat()
            }) {
                Icon(Icons.Filled.Add, contentDescription = "New chat")
                Text("  New chat")
            }
        },
    ) { padding ->
        if (chats.chats.isEmpty()) {
            Column(Modifier.fillMaxSize().padding(padding).padding(24.dp)) {
                Text("No chats yet", style = MaterialTheme.typography.titleMedium)
                Text(
                    "Tap “New chat” to open your first conversation.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        } else {
            LazyColumn(Modifier.fillMaxSize().padding(padding)) {
                items(chats.chats, key = { it.id }) { chat ->
                    ListItem(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onOpen(chat.id) },
                        headlineContent = {
                            Text(chat.title.ifBlank { "Untitled" }, fontWeight = FontWeight.SemiBold)
                        },
                        supportingContent = {
                            val updated = runCatching {
                                ZonedDateTime.parse(chat.updatedAt).format(formatter)
                            }.getOrDefault("")
                            Text("${chat.model ?: "default"} · $updated")
                        },
                        trailingContent = {
                            Row {
                                if (chat.location != null) {
                                    AssistChip(onClick = {}, label = { Text(chat.location) })
                                }
                            }
                        },
                    )
                }
            }
        }
    }
}