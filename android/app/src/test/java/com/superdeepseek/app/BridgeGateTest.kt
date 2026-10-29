package com.superdeepseek.app

import android.webkit.JavascriptInterface
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeGateTest {
    class Target {
        var calls = 0
        var lastKey: String? = "unset"
        @JavascriptInterface fun getStorage(key: String?): String? { calls++; lastKey = key; return if (key == "k") "v" else null }
        @JavascriptInterface fun vibrate(millis: Long) { calls++ ; lastKey = millis.toString() }
        @JavascriptInterface fun reportTheme(dark: Boolean) { calls++; lastKey = dark.toString() }
        @JavascriptInterface fun open(a: String?, b: String?): Boolean { calls++; return a == "x" && b == null }
        @JavascriptInterface fun boom(): String = throw IllegalStateException("nope")
        fun notExposed(): String { calls++; return "secret" }
    }

    @Test fun wrongOrMissingTokenNeverReachesTarget() {
        val t = Target(); val g = BridgeGate(t, "a".repeat(64))
        assertEquals("{\"e\":\"denied\"}", g.call("b".repeat(64), "getStorage", "[\"k\"]"))
        assertEquals("{\"e\":\"denied\"}", g.call(null, "getStorage", "[\"k\"]"))
        assertEquals("{\"e\":\"denied\"}", g.call("", "getStorage", "[\"k\"]"))
        assertEquals(0, t.calls)
    }

    @Test fun onlyAnnotatedMethodsAreCallable() {
        val t = Target(); val g = BridgeGate(t, "tok")
        assertTrue(g.call("tok", "notExposed", "[]").contains("unknown method"))
        assertFalse(g.methodNames.contains("notExposed"))
        assertTrue(g.methodNames.containsAll(listOf("getStorage", "vibrate", "reportTheme", "open")))
        assertFalse(g.methodNames.contains("call"))
        assertEquals(0, t.calls)
    }

    @Test fun convertsArgumentsAndReturnValues() {
        val t = Target(); val g = BridgeGate(t, "tok")
        assertEquals("v", JSONObject(g.call("tok", "getStorage", "[\"k\"]")).getString("v"))
        assertTrue(JSONObject(g.call("tok", "getStorage", "[\"zz\"]")).isNull("v"))
        assertEquals("{}", g.call("tok", "vibrate", "[25]"))
        assertEquals("25", t.lastKey)
        assertEquals("{}", g.call("tok", "reportTheme", "[true]"))
        assertEquals("true", t.lastKey)
        assertTrue(JSONObject(g.call("tok", "open", "[\"x\",null]")).getBoolean("v"))
        // Missing trailing args become null, like the Java bridge's undefined → null.
        assertTrue(JSONObject(g.call("tok", "open", "[\"x\"]")).getBoolean("v"))
        assertEquals("nope", JSONObject(g.call("tok", "boom", "[]")).getString("e"))
        assertTrue(g.call("tok", "getStorage", "not json").contains("bad arguments"))
    }

    @Test fun shimKeepsTokenOutOfGlobals() {
        val g = BridgeGate(Target(), "tok123")
        val s = g.shimScript()
        assertTrue(s.contains("window.SdsBridgeGate"))
        assertTrue(s.contains("\"tok123\""))
        assertFalse(s.contains("window.token"))
        assertTrue(s.contains("Object.defineProperty(window,'AndroidBridge'"))
    }

    @Test fun tokensAreRandomAndLong() {
        val a = BridgeGate.newToken(); val b = BridgeGate.newToken()
        assertEquals(64, a.length); assertFalse(a == b)
    }
}
