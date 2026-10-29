package com.superdeepseek.app

import android.view.WindowManager
import androidx.core.view.ViewCompat
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented tests that verify edge-to-edge rendering is correctly configured in MainActivity.
 *
 * Must run on a connected device or emulator (API 26+). These tests do NOT exercise web content
 * rendering — they assert only that the Activity has configured the window and WebView correctly.
 *
 * Run with: ./gradlew connectedDebugAndroidTest
 */
@RunWith(AndroidJUnit4::class)
class EdgeToEdgeTest {

    @get:Rule
    val activityRule = ActivityScenarioRule(MainActivity::class.java)

    @Test
    fun systemBars_doNotAddAnAutomaticContrastScrim() {
        activityRule.scenario.onActivity { activity ->
            if (android.os.Build.VERSION.SDK_INT >= 29) {
                assertFalse(
                    "Status bar contrast scrim must stay disabled; page colors drive the bars",
                    activity.window.isStatusBarContrastEnforced,
                )
                assertFalse(
                    "Navigation bar contrast scrim must stay disabled; page colors drive the bars",
                    activity.window.isNavigationBarContrastEnforced,
                )
            }
        }
    }

    @Test
    fun window_hasFlagDrawsSystemBarBackgrounds() {
        activityRule.scenario.onActivity { activity ->
            val flags = activity.window.attributes.flags
            assertTrue(
                "FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS required for transparent system bars",
                flags and WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS != 0,
            )
        }
    }

    @Test
    fun decorView_doesNotFitSystemWindows() {
        activityRule.scenario.onActivity { activity ->
            assertFalse(
                "setDecorFitsSystemWindows(false) must be applied for edge-to-edge",
                ViewCompat.getFitsSystemWindows(activity.window.decorView),
            )
        }
    }

}
