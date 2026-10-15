package app.foundry.android.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import app.foundry.android.core.FileEntry
import app.foundry.android.core.FoundryError
import app.foundry.android.core.bool
import app.foundry.android.core.str
import app.foundry.android.data.AppState
import app.foundry.android.data.AppStore
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Workspace file browser (§1.3 files.*) over the chat's bound env. v1:
 * browse, read, mkdir, rm — writes stay a server/desktop concern for now.
 */
@Composable
fun FilesScreen(store: AppStore, state: AppState, chatId: String) {
    val scope = rememberCoroutineScope()
    val envId = store.chatById(chatId)?.envId
    var path by remember { mutableStateOf(".") }
    var entries by remember { mutableStateOf<List<FileEntry>>(emptyList()) }
    var error by remember { mutableStateOf("") }
    var preview by remember { mutableStateOf<Pair<String, String>?>(null) }
    var mkdirOpen by remember { mutableStateOf(false) }
    var rmPath by remember { mutableStateOf<String?>(null) }

    fun load(p: String) {
        val sock = store.socketOrNull() ?: return
        scope.launch {
            try {
                val params = buildJsonObject {
                    put("path", p)
                    if (envId != null) put("envId", envId)
                }
                val payload = sock.request("files.list", params) ?: return@launch
                val list = payload as? kotlinx.serialization.json.JsonArray ?: return@launch
                entries = list.mapNotNull { el ->
                    runCatching {
                        store.decodeFileEntry(el)
                    }.getOrNull()
                }
                path = p
                error = ""
            } catch (err: FoundryError) {
                error = err.message ?: "files.list failed"
            }
        }
    }

    LaunchedEffect(chatId) { load(".") }

    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            OutlinedButton(onClick = { load(parentOf(path)) }) { Text("⬆ up") }
            OutlinedButton(onClick = { load(".") }) { Text("root") }
            OutlinedButton(onClick = { mkdirOpen = true }) { Text("+ dir") }
            Text("$path", style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(top = 12.dp))
        }
        if (error.isNotBlank()) {
            Text(error, color = MaterialTheme.colorScheme.error)
        }
        LazyColumn(Modifier.weight(1f)) {
            items(entries, key = { it.path }) { file ->
                Row(
                    Modifier.fillMaxWidth().clickable {
                        if (file.isDir) {
                            load(file.path)
                        } else {
                            scope.launch { openPreview(store, file.path, envId) { p -> preview = p } }
                        }
                    },
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        (if (file.isDir) "📁 " else "📄 ") + file.path.substringAfterLast('/'),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    TextButton(onClick = { rmPath = file.path }) { Text("del") }
                }
            }
            if (entries.isEmpty() && error.isBlank()) {
                item { Text("(empty)", style = MaterialTheme.typography.bodySmall) }
            }
        }
    }

    preview?.let { (p, content) ->
        AlertDialog(
            onDismissRequest = { preview = null },
            confirmButton = { TextButton(onClick = { preview = null }) { Text("Close") } },
            title = { Text(p, style = MaterialTheme.typography.titleSmall) },
            text = {
                Column(Modifier.padding(vertical = 4.dp)) {
                    Text(
                        content.take(4_000),
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            },
        )
    }

    if (mkdirOpen) {
        var name by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { mkdirOpen = false },
            confirmButton = {
                Button(
                    onClick = {
                        mkdirOpen = false
                        val sock = store.socketOrNull()
                        if (sock != null && name.isNotBlank()) {
                            scope.launch {
                                runCatching {
                                    sock.request(
                                        "files.mkdir",
                                        buildJsonObject {
                                            put("path", (if (path == ".") "" else "$path/") + name.trim())
                                            if (envId != null) put("envId", envId)
                                        },
                                        idem = store.idem("files-mkdir"),
                                    )
                                }
                                load(path)
                            }
                        }
                    },
                ) { Text("Create") }
            },
            dismissButton = { TextButton(onClick = { mkdirOpen = false }) { Text("Cancel") } },
            title = { Text("New directory") },
            text = { OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name") }) },
        )
    }

    rmPath?.let { target ->
        AlertDialog(
            onDismissRequest = { rmPath = null },
            confirmButton = {
                Button(
                    onClick = {
                        rmPath = null
                        val sock = store.socketOrNull()
                        if (sock != null) {
                            scope.launch {
                                runCatching {
                                    sock.request(
                                        "files.rm",
                                        buildJsonObject {
                                            put("path", target)
                                            if (envId != null) put("envId", envId)
                                        },
                                        idem = store.idem("files-rm"),
                                    )
                                }
                                load(path)
                            }
                        }
                    },
                ) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { rmPath = null }) { Text("Cancel") } },
            title = { Text("Delete") },
            text = { Text(target) },
        )
    }
}

private fun parentOf(path: String): String {
    val normalized = path.trimEnd('/')
    val idx = normalized.lastIndexOf('/')
    return if (idx <= 0) "." else normalized.substring(0, idx)
}

private suspend fun openPreview(
    store: AppStore,
    path: String,
    envId: String?,
    set: (Pair<String, String>) -> Unit,
) {
    val sock = store.socketOrNull() ?: return
    try {
        val payload = sock.request("files.read", buildJsonObject {
            put("path", path)
            if (envId != null) put("envId", envId)
        }) ?: return
        val raw = payload.str("content") ?: ""
        val content = if (payload.bool("b64") == true) {
            runCatching { String(java.util.Base64.getDecoder().decode(raw), Charsets.UTF_8) }.getOrDefault("(binary file)")
        } else {
            raw.ifEmpty { "(empty file)" }
        }
        set(path to content)
    } catch (err: FoundryError) {
        set(path to "read failed: ${err.message}")
    }
}