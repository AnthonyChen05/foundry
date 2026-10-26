package app.foundry.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.foundry.android.FoundryApp
import app.foundry.android.data.AppState
import app.foundry.android.data.AppStore
import app.foundry.android.core.FoundryError
import androidx.compose.material3.HorizontalDivider
import kotlinx.coroutines.launch

/**
 * Operator settings: session + connection, executor presence (ADR-015),
 * model catalog, password change (ADR-014), ntfy push (ADR-009), logout,
 * recent in-app notifications.
 */
@Composable
fun SettingsScreen(store: AppStore, state: AppState, activity: androidx.activity.ComponentActivity) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val app = FoundryApp.of(context)

    var current by rememberSaveable { mutableStateOf("") }
    var next by rememberSaveable { mutableStateOf("") }
    var pwMsg by remember { mutableStateOf("") }
    var ntfyUrl by rememberSaveable { mutableStateOf("") }
    var ntfyTopic by rememberSaveable { mutableStateOf("") }
    var ntfyOn by rememberSaveable { mutableStateOf(false) }

    // Prefill ntfy preferences once the persisted session info lands.
    val sessionInfo by remember { app.sessions.observe() }.collectAsState(initial = null)
    androidx.compose.runtime.LaunchedEffect(sessionInfo) {
        val info = sessionInfo ?: return@LaunchedEffect
        if (ntfyUrl.isEmpty() && ntfyTopic.isEmpty()) {
            ntfyUrl = info.ntfyUrl ?: ""
            ntfyTopic = info.ntfyTopic ?: ""
            ntfyOn = info.ntfyUrl != null
        }
    }

    fun changePassword() {
        val rest = store.restOrNull() ?: return
        val token = store.currentToken() ?: return
        scope.launch {
            try {
                rest.changePassword(token, current, next)
                pwMsg = "password changed"
                current = ""
                next = ""
            } catch (err: FoundryError) {
                pwMsg = err.message ?: "failed"
            }
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // Session card.
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Server", style = MaterialTheme.typography.titleMedium)
                Text(state.serverUrl.ifBlank { "—" }, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace)
                Text("signed in as ${state.username.ifBlank { "?" }} · conn ${state.conn.name.lowercase()}")
                if (state.connError.isNotBlank()) {
                    Text(state.connError, color = MaterialTheme.colorScheme.error)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { store.reconnect() }) { Text("Reconnect") }
                    Button(onClick = { store.logout() }) { Text("Sign out") }
                }
            }
        }

        // Executor (ADR-015).
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Executor", style = MaterialTheme.typography.titleMedium)
                val exec = state.executor
                if (exec == null) {
                    Text("probing…")
                } else if (!exec.online) {
                    Text("no desktop executor registered — chats run in cloud envs")
                } else {
                    Text("online: ${exec.name ?: "runner"}${exec.version?.let { " v$it" } ?: ""}")
                    exec.dockerAvailable?.let { Text("docker: $it") }
                    exec.workspaceRoot?.let { Text("workspaces: $it") }
                }
            }
        }

        // Models.
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Models", style = MaterialTheme.typography.titleMedium)
                if (state.models.isEmpty()) {
                    Text("catalog empty — configure providers server-side")
                } else {
                    state.models.forEach { model ->
                        Text("• ${model.name.ifBlank { model.id }} (${model.provider})")
                    }
                }
            }
        }

        // Providers (admin REST §2.1; models omitted → server auto-pull).
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Providers", style = MaterialTheme.typography.titleMedium)
                var providers by remember { mutableStateOf<List<app.foundry.android.data.ProviderRow>>(emptyList()) }
                var pKind by rememberSaveable { mutableStateOf("openai_compat") }
                var pBase by rememberSaveable { mutableStateOf("") }
                var pKey by rememberSaveable { mutableStateOf("") }
                var pModels by rememberSaveable { mutableStateOf("") }
                var provMsg by remember { mutableStateOf("") }
                var provBusy by remember { mutableStateOf(false) }

                suspend fun reloadProviders() {
                    val rest = store.restOrNull() ?: return
                    val token = store.currentToken() ?: return
                    providers = rest.adminListProviders(token)
                }

                androidx.compose.runtime.LaunchedEffect(Unit) {
                    runCatching { reloadProviders() }
                }

                // The list.
                if (providers.isEmpty()) {
                    Text("no providers configured", color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    providers.forEach { p ->
                        Column(Modifier.fillMaxWidth()) {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                                Text("• ${p.id}", fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace)
                                Text(p.kind, Modifier.padding(start = 4.dp))
                                if (p.hasKey) Text("🔑")
                                androidx.compose.material3.TextButton(onClick = {
                                    val rest = store.restOrNull() ?: return@TextButton
                                    val token = store.currentToken() ?: return@TextButton
                                    scope.launch {
                                        provBusy = true
                                        try {
                                            rest.deleteProvider(token, p.id)
                                            reloadProviders()
                                            provMsg = "deleted ${p.id}"
                                        } catch (err: FoundryError) {
                                            provMsg = err.message ?: "delete failed"
                                        } finally {
                                            provBusy = false
                                        }
                                    }
                                }) { Text("delete", color = MaterialTheme.colorScheme.error) }
                            }
                            p.baseUrl?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        }
                    }
                }

                // The add form.
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    androidx.compose.material3.FilterChip(
                        selected = pKind == "openai_compat",
                        onClick = { pKind = "openai_compat" },
                        label = { Text("openai_compat") },
                    )
                    androidx.compose.material3.FilterChip(
                        selected = pKind == "anthropic",
                        onClick = { pKind = "anthropic" },
                        label = { Text("anthropic") },
                    )
                }
                OutlinedTextField(
                    value = pBase,
                    onValueChange = { pBase = it },
                    label = { Text("base URL (e.g. http://host:11434/v1)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = pKey,
                    onValueChange = { pKey = it },
                    label = { Text("API key (vaulted server-side)") },
                    visualTransformation = PasswordVisualTransformation(),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = pModels,
                    onValueChange = { pModels = it },
                    label = { Text("models — one per line (empty = auto-pull)") },
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(
                    onClick = {
                        scope.launch {
                            provBusy = true
                            provMsg = ""
                            try {
                                val rest = store.restOrNull() ?: throw FoundryError("internal", "not connected")
                                val token = store.currentToken() ?: throw FoundryError("internal", "no session")
                                val res = rest.upsertProvider(
                                    token,
                                    pKind,
                                    pBase.trim(),
                                    pKey.trim().ifBlank { null },
                                    pModels.split("\n").map { it.trim() }.filter { it.isNotEmpty() }.ifEmpty { null },
                                )
                                provMsg = when {
                                    res.pullError != null -> "saved " + res.id + ", but auto-pull failed: " + res.pullError
                                    res.pulled == true -> "saved " + res.id + " — " + res.models.size + " model(s) pulled from the provider"
                                    else -> "saved " + res.id
                                }
                                pKey = ""
                                store.refreshCatalog()
                                reloadProviders()
                            } catch (err: FoundryError) {
                                provMsg = err.message ?: "failed"
                            } finally {
                                provBusy = false
                            }
                        }
                    },
                    enabled = !provBusy && pBase.isNotBlank(),
                ) { Text(if (provBusy) "Saving…" else "Add provider") }
                if (provMsg.isNotBlank()) {
                    Text(provMsg, style = MaterialTheme.typography.bodySmall)
                }
            }
        }

        // Password change.
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Change password", style = MaterialTheme.typography.titleMedium)
                OutlinedTextField(
                    value = current,
                    onValueChange = { current = it },
                    label = { Text("Current password") },
                    visualTransformation = PasswordVisualTransformation(),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = next,
                    onValueChange = { next = it },
                    label = { Text("New password (8–128)") },
                    visualTransformation = PasswordVisualTransformation(),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = { changePassword() },
                        enabled = current.isNotBlank() && next.length >= 8,
                    ) { Text("Update") }
                }
                if (pwMsg.isNotBlank()) Text(pwMsg)
            }
        }

        // ntfy push (ADR-009).
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Push (self-hosted ntfy)", style = MaterialTheme.typography.titleMedium)
                Text(
                    "While the app is open it streams your topic; when it's closed, subscribe the ntfy Android app to the same topic.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = ntfyUrl,
                    onValueChange = { ntfyUrl = it },
                    label = { Text("ntfy server URL") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = ntfyTopic,
                    onValueChange = { ntfyTopic = it },
                    label = { Text("topic") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Switch(checked = ntfyOn, onCheckedChange = { on ->
                        ntfyOn = on
                        app.setNtfy(ntfyUrl.trim(), ntfyTopic.trim(), on)
                    })
                    Text(if (ntfyOn) "Subscribed" else "Off", Modifier.padding(top = 12.dp))
                }
            }
        }

        // Notifications (notify.push events seen in-session).
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Recent pushes", style = MaterialTheme.typography.titleMedium)
                if (state.notifications.isEmpty()) {
                    Text("none yet")
                } else {
                    state.notifications.takeLast(10).asReversed().forEach { n ->
                        Text("• ${n.title}: ${n.body}", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }

        HorizontalDivider()
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { store.logout() }) { Text("Sign out") }
        }
        Text(
            "Foundry android ${android.os.Build.VERSION.SDK_INT} · v0.1.0",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}