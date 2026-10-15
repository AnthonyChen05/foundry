package app.foundry.android

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.core.content.ContextCompat
import app.foundry.android.data.AppStore
import app.foundry.android.data.Phase
import app.foundry.android.ui.FoundryRoot
import app.foundry.android.ui.theme.FoundryTheme

class MainActivity : ComponentActivity() {
    private lateinit var store: AppStore

    private val requestNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* ntfy/notify simply won't post when denied */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        ensureNotificationPermission()

        val app = FoundryApp.of(this)
        app.resumeNtfy()
        store = app.ensureStore()

        val focusRunId = intent?.getStringExtra("runId")
        setContent {
            FoundryTheme {
                val state by store.state.collectAsState()
                if (focusRunId != null && state.phase == Phase.READY) {
                    LaunchedEffect(focusRunId) { store.focusRun(focusRunId) }
                }
                FoundryRoot(store, state, this)
            }
        }
    }

    private fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                requestNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }
}