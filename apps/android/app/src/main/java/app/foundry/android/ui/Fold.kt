package app.foundry.android.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.remember
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowLayoutInfo

/**
 * Fold-awareness (developer.android.com/develop/adaptive-apps/guides/
 * foldables/make-your-app-fold-aware): observe the window's folding features
 * through Jetpack WindowManager's WindowInfoTracker. Emissions recompose the
 * call site — fold/unfold and posture changes re-render with no lifecycle
 * wiring of our own.
 */
@Composable
fun rememberFoldingFeatures(activity: ComponentActivity): List<FoldingFeature> {
    val tracker = remember(activity) { WindowInfoTracker.getOrCreate(activity) }
    val info: State<WindowLayoutInfo> = tracker
        .windowLayoutInfo(activity)
        .collectAsState(initial = WindowLayoutInfo(emptyList()))
    return info.value.displayFeatures.filterIsInstance<FoldingFeature>()
}

/** The fold that partitions the window (HALF_OPENED folds always separate; dual-screen spans when the app crosses both). */
fun foldingFeatureOf(features: List<FoldingFeature>): FoldingFeature? = features.firstOrNull { it.isSeparating }

/**
 * Book posture (per the guide): a separating fold with a VERTICAL hinge —
 * the window splits left|right; use the hinge as the layout separator.
 */
val FoldingFeature.isBook: Boolean
    get() = isSeparating && orientation == FoldingFeature.Orientation.VERTICAL

/**
 * Table-top posture: a separating fold with a HORIZONTAL hinge —
 * the window splits top/bottom; content above, hands below.
 */
val FoldingFeature.isTabletop: Boolean
    get() = isSeparating && orientation == FoldingFeature.Orientation.HORIZONTAL