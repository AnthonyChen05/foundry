package app.foundry.android.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import app.foundry.android.data.AppState
import app.foundry.android.data.AppStore
import app.foundry.android.data.Conn
import app.foundry.android.data.Phase
import app.foundry.android.ui.screens.ChatScreen
import app.foundry.android.ui.screens.ChatsScreen
import app.foundry.android.ui.screens.FilesScreen
import app.foundry.android.ui.screens.LoginScreen
import app.foundry.android.ui.screens.SettingsScreen
import app.foundry.android.ui.screens.TermScreen
import app.foundry.android.ui.screens.TimelineScreen

/**
 * Single-activity navigation. BOOT → splash; LOGIN → login; READY → bottom
 * bar (Chats / Settings) with a NavHost for chat, run timeline, terminal and
 * files routes. Every screen reads the store — server-authoritative, no
 * screen-local truth beyond widgets.
 */
@Composable
fun FoundryRoot(store: AppStore, state: AppState, activity: ComponentActivity) {
    when (state.phase) {
        Phase.BOOT -> BootSplash()
        Phase.LOGIN -> LoginScreen(store)
        Phase.READY -> ReadyShell(store, state, activity)
    }
}

@Composable
private fun BootSplash() {
    Scaffold { padding ->
        Text("Foundry…", Modifier.padding(padding))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ReadyShell(store: AppStore, state: AppState, activity: ComponentActivity) {
    val nav = rememberNavController()

    Scaffold(
        topBar = {
            val entry by nav.currentBackStackEntryAsState()
            val route = entry?.destination?.route ?: "chats"
            if (route != "chats" && route != "settings") {
                CenterAlignedTopAppBar(
                    title = { Text(topTitle(route)) },
                    navigationIcon = {
                        IconButton(onClick = { nav.popBackStack() }) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                        }
                    },
                    actions = {
                        val conn = when (state.conn) {
                            Conn.OPEN -> "●"
                            Conn.RECONNECTING -> "◌"
                            Conn.CONNECTING -> "◌"
                            else -> "○"
                        }
                        Text("$conn ${state.conn.name.lowercase()}", Modifier.padding(horizontal = 12.dp))
                    },
                )
            }
        },
        bottomBar = {
            val entry by nav.currentBackStackEntryAsState()
            val route = entry?.destination?.route ?: "chats"
            if (route == "chats" || route == "settings") {
                NavigationBar {
                    NavigationBarItem(
                        selected = route == "chats",
                        onClick = { nav.navigate("chats") { popUpTo("chats") { inclusive = true } } },
                        icon = { Icon(Icons.Filled.Chat, contentDescription = "Chats") },
                        label = { Text("Chats") },
                    )
                    NavigationBarItem(
                        selected = route == "settings",
                        onClick = { nav.navigate("settings") { launchSingleTop = true; popUpTo("chats") { inclusive = false } } },
                        icon = { Icon(Icons.Filled.Settings, contentDescription = "Settings") },
                        label = { Text("Settings") },
                    )
                }
            }
        },
    ) { padding ->
        NavHost(navController = nav, startDestination = "chats", modifier = Modifier.padding(padding)) {
            composable("chats") {
                ChatsScreen(store, state, onOpen = { chatId -> nav.navigate("chat/$chatId") }, onNewChat = { nav.navigate("chat/new") })
            }
            composable(
                "chat/{chatId}",
                arguments = listOf(navArgument("chatId") { type = NavType.StringType }),
            ) { entry ->
                ChatScreen(
                    store,
                    state,
                    chatId = entry.arguments?.getString("chatId") ?: "",
                    onOpenTimeline = { runId -> nav.navigate("timeline/$runId") },
                    onOpenTerm = { chatIdParam -> nav.navigate("term/$chatIdParam") },
                    onOpenFiles = { chatIdParam -> nav.navigate("files/$chatIdParam") },
                )
            }
            composable(
                "timeline/{runId}",
                arguments = listOf(navArgument("runId") { type = NavType.StringType }),
            ) { entry ->
                TimelineScreen(store, state, runId = entry.arguments?.getString("runId") ?: "")
            }
            composable(
                "term/{chatId}",
                arguments = listOf(navArgument("chatId") { type = NavType.StringType }),
            ) { entry ->
                TermScreen(store, state, chatId = entry.arguments?.getString("chatId") ?: "")
            }
            composable(
                "files/{chatId}",
                arguments = listOf(navArgument("chatId") { type = NavType.StringType }),
            ) { entry ->
                FilesScreen(store, state, chatId = entry.arguments?.getString("chatId") ?: "")
            }
            composable("settings") { SettingsScreen(store, state, activity) }
        }
    }
}

private fun topTitle(route: String): String = when {
    route.startsWith("chat/") -> "Chat"
    route.startsWith("timeline/") -> "Run"
    route.startsWith("term/") -> "Terminal"
    route.startsWith("files/") -> "Files"
    else -> "Foundry"
}