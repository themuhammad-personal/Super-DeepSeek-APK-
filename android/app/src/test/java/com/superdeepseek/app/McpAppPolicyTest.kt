package com.superdeepseek.app

import org.junit.Assert.*
import org.junit.Test

/** Pure policy tests: no Android runtime, no network. */
class McpAppPolicyTest {
    @Test fun `resource and server URIs are allowlisted`() {
        assertTrue(McpAppPolicy.validResourceUri("ui://weather/home"))
        assertTrue(McpAppPolicy.validResourceUri("ui://weather-server/dashboard-template"))
        assertTrue(McpAppPolicy.validResourceUri("https://example.com/app.html"))
        assertFalse(McpAppPolicy.validResourceUri(null))
        assertFalse(McpAppPolicy.validResourceUri("javascript:alert(1)"))
        assertFalse(McpAppPolicy.validResourceUri("file:///etc/passwd"))
        assertFalse(McpAppPolicy.validResourceUri("http://plain.example/app"))
        assertFalse(McpAppPolicy.validResourceUri("https://user:pass@host/x"))
        assertFalse(McpAppPolicy.validResourceUri("ui://host/../../etc"))
        assertFalse(McpAppPolicy.validResourceUri("x".repeat(1000)))
        assertTrue(McpAppPolicy.validServerUrl("https://mcp.example.com/mcp"))
        assertFalse(McpAppPolicy.validServerUrl("ftp://mcp.example.com"))
    }

    @Test fun `only spec view methods cross the relay`() {
        for (m in listOf("ui/initialize", "ui/notifications/initialized", "ping", "tools/list", "tools/call", "resources/read", "notifications/message"))
            assertTrue(McpAppPolicy.methodAllowed(m))
        for (m in listOf("ui/secret", "storage/get", "AndroidBridge", null, "", "x".repeat(200)))
            assertFalse(McpAppPolicy.methodAllowed(m))
    }

    @Test fun `app tool visibility follows spec defaults`() {
        assertTrue(McpAppPolicy.toolCallableFromApp(null))
        assertTrue(McpAppPolicy.toolCallableFromApp(listOf("model", "app")))
        assertTrue(McpAppPolicy.toolCallableFromApp(listOf("app")))
        assertFalse(McpAppPolicy.toolCallableFromApp(listOf("model")))
        assertFalse(McpAppPolicy.toolCallableFromApp(emptyList()))
    }

    @Test fun `request ledger suppresses duplicates and fails closed when full`() {
        val ledger = McpAppPolicy.RequestLedger(max = 2)
        assertTrue(ledger.first("1"))
        assertFalse(ledger.first("1"))
        assertTrue(ledger.first("2"))
        assertFalse(ledger.first("3")) // full: new ids are refused, never evicting old ones
        assertFalse(ledger.first("1"))
    }

    @Test fun `ids and relay payloads are bounded`() {
        assertEquals("12", McpAppPolicy.boundedId(12))
        assertEquals("abc", McpAppPolicy.boundedId("abc"))
        assertNull(McpAppPolicy.boundedId(null))
        assertNull(McpAppPolicy.boundedId(true))
        assertNull(McpAppPolicy.boundedId("x".repeat(200)))
        assertEquals("abc", McpAppPolicy.bounded("abc", 3))
        assertEquals("ab", McpAppPolicy.bounded("abc", 2))
    }

    @Test fun `handshake gates host dispatch until initialized`() {
        val h = McpAppPolicy.Handshake()
        assertFalse(h.initialized)
        h.onInitialize()
        assertFalse(h.initialized)
        h.onInitialized()
        assertTrue(h.initialized)
    }
}
