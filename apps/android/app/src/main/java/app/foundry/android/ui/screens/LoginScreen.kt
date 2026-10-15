package app.foundry.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.foundry.android.data.AppStore
import kotlinx.coroutines.launch

/**
 * ADR-014 login: server URL + username + password. The backend issues a
 * 30-day session token; API keys are programmatic-only and not accepted here
 * (OpenAI-compatible clients use those, this app doesn't).
 */
@Composable
fun LoginScreen(store: AppStore) {
    val state by store.state.collectAsState()
    var server by rememberSaveable { mutableStateOf(state.serverUrl.ifEmpty { "http://" }) }
    var username by rememberSaveable { mutableStateOf(state.username.ifEmpty { "admin" }) }
    var password by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Surface(Modifier.fillMaxSize()) {
        Column(
            Modifier
                .fillMaxSize()
                .padding(24.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            Text("Foundry", style = MaterialTheme.typography.displayMedium)
            Text(
                "Self-hosted backend · trusted gateway, untrusted execution",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(24.dp))
            OutlinedTextField(
                value = server,
                onValueChange = { server = it },
                label = { Text("Server URL") },
                supportingText = { Text("e.g. http://10.0.2.2:8787 (emulator) or your tailnet address") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = username,
                onValueChange = { username = it },
                label = { Text("Username") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text("Password") },
                visualTransformation = PasswordVisualTransformation(),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            if (state.connError.isNotBlank()) {
                Spacer(Modifier.height(8.dp))
                Text(state.connError, color = MaterialTheme.colorScheme.error)
            }
            Spacer(Modifier.height(16.dp))
            Button(
                onClick = {
                    if (server.isBlank() || username.isBlank() || password.isBlank() || busy) return@Button
                    busy = true
                    scope.launch {
                        store.loginWithPassword(server, username, password)
                        busy = false
                    }
                },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (busy) {
                    CircularProgressIndicator(Modifier.size(20.dp))
                } else {
                    Text("Sign in")
                }
            }
            Spacer(Modifier.height(16.dp))
            Text(
                "First boot? The generated admin credentials are in the core data dir → admin_credentials.txt.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}