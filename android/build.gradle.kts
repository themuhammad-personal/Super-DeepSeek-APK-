// Top-level build file. Subprojects pull plugin versions from here.
//
// Toolchain policy (see docs/TOOLCHAIN.md): stay on a supported AGP line, keep
// compileSdk/targetSdk on the newest stable platform, and move deliberately —
// one supported line at a time — because the engine rides on a live website and
// a broken build means no fix can ship.
//
// AGP 8.13 is the last 8.x line: it supports compileSdk/targetSdk 36 (Android 16)
// and Kotlin 2.3, and it needs Gradle 8.13. Moving to AGP 9.x also means moving
// to Gradle 9.6 and the new Variant API, which is a separate, testable step.
plugins {
    id("com.android.application") version "8.13.2" apply false
    id("org.jetbrains.kotlin.android") version "2.3.21" apply false
}
