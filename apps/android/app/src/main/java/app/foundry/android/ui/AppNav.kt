package app.foundry.android.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.coerceAtLeast
import androidx.compose.ui.unit.coerceAtMost
import androidx.compose.ui.unit.dp
import androidx.compose.material3.windowsizeclass.ExperimentalMaterial3WindowSizeClassApi
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.material3.windowsizeclass.calculateWindowSizeClass
import androidx.window.layout.FoldingFeature
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
 *
 * Fold-awareness (make-your-app-fold-aware): the chats route becomes a
 * two-pane list/detail shell when the window is at least MEDIUM wide OR the
 * device presents a book-posture fold; the hinge's left edge is the split —
 * the detail lands on the unfolded side and nothing sits on the hinge.
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

private val LIST_MIN = 260.dp
private val LIST_MAX = 480.dp

/** List pane width: book folds split at the hinge; plain wide windows get a fixed column. */
@Composable
private fun listPaneWidth(fold: FoldingFeature?): Dp {
    if (fold != null && fold.isBook) {
        val windowDp = with(LocalDensity.current) { fold.bounds.right.toDp() }
        val hingeDp = with(LocalDensity.current) { fold.bounds.left.toDp() }
        return hingeDp.coerceAtLeast(LIST_MIN).coerceAtMost((windowDp * 0.6f))
    }
    return 340.dp.coerceAtLeast(LIST_MIN)
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3WindowSizeClassApi::class)
@Composable
private fun ReadyShell(store: AppStore, state: AppState, activity: ComponentActivity) {
    val nav = rememberNavController()
    val widthClass = calculateWindowSizeClass(activity).widthSizeClass
    val fold = foldingFeatureOf(rememberFoldingFeatures(activity))
    // Book-posture folds split the window even on otherwise-compact widths.
    val expanded = widthClass != WindowWidthSizeClass.Compact || fold?.isSeparating == true

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
                if (expanded) {
                    // Two-pane (list | detail): the fold/hinge is the split
                    // when present; the detail drives from the store's
                    // activeChatId — no navigation, no back-stack surprises.
                    val listWidth = listPaneWidth(fold)
                    Row(Modifier.fillMaxSize()) {
                        Box(Modifier.width(listWidth)) {
                            // The store creates + selects the new chat; the
                            // detail pane follows via activeChatId.
                            ChatsScreen(store, state, onOpen = { chatId -> store.selectChat(chatId) }, onNewChat = {})
                        }
                        VerticalDivider()
                        Box(Modifier.fillMaxSize().weight(1f)) {
                            val active = state.activeChatId
                            if (active.isEmpty()) {
                                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                    Text(
                                        "Select a chat",
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            } else {
                                ChatScreen(
                                    store,
                                    state,
                                    chatId = active,
                                    onOpenTimeline = { runId -> nav.navigate("timeline/$runId") },
                                    onOpenTerm = { chatIdParam -> nav.navigate("term/$chatIdParam") },
                                    onOpenFiles = { chatIdParam -> nav.navigate("files/$chatIdParam") },
                                )
                            }
                        }
                    }
                } else {
                    ChatsScreen(store, state, onOpen = { chatId -> nav.navigate("chat/$chatId") }, onNewChat = { nav.navigate("chat/new") })
                }
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