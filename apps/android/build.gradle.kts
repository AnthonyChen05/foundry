// Foundry Android client (P4 #4) — Kotlin + Compose thin view over the
// server-authoritative core. Versions pinned to what this machine's gradle
// cache already proves (AGP 9.2.1 / Kotlin 2.4.x / Gradle 9.4.1).
plugins {
    id("com.android.application") version "9.2.1" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.0" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.4.0" apply false
}