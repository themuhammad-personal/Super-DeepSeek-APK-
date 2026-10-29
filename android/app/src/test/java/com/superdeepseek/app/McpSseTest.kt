package com.superdeepseek.app

import org.junit.Assert.*
import org.junit.Test
import java.io.BufferedReader
import java.io.StringReader

class McpSseTest {
    private fun r(s: String) = BufferedReader(StringReader(s))

    @Test fun `joins multi-line data and matches the request id`() {
        val body = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n" +
            "data: {\"jsonrpc\":\"2.0\",\"id\":7,\n" +
            "data: \"result\":{\"ok\":1}}\n\n"
        val m = McpSse.readResponse(r(body), 7, 1_000_000)
        assertNotNull(m); assertEquals(1, m!!.getJSONObject("result").getInt("ok"))
    }

    @Test fun `skips responses for other ids and stops at the match`() {
        val body = "data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"a\":1}}\n\n" +
            "data: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"a\":2}}\n\n" +
            "data: this-is-never-read\n"
        assertEquals(2, McpSse.readResponse(r(body), 2, 1_000_000)!!.getJSONObject("result").getInt("a"))
    }

    @Test fun `id compare tolerates string versus number but rejects unmatched responses`() {
        assertNotNull(McpSse.readResponse(r("data: {\"id\":\"3\",\"result\":{}}\n\n"), 3, 1000))
        val unrelated = "data: {\"id\":9,\"result\":{\"x\":1}}\n"
        assertNull(McpSse.readResponse(r(unrelated), 3, 1000))
        val staleThenProgress = "data: {\"jsonrpc\":\"2.0\",\"id\":9,\"result\":{\"x\":1}}\n\n" +
            "data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n"
        assertNull(McpSse.readResponse(r(staleThenProgress), 3, 1000))
        assertNull(McpSse.readResponse(r("data: [DONE]\n\n"), 3, 1000))
    }

    @Test fun `errors are returned and size is bounded`() {
        val e = McpSse.readResponse(r("data:{\"id\":1,\"error\":{\"message\":\"no\"}}\n\n"), 1, 1000)
        assertTrue(e!!.has("error"))
        try { McpSse.readResponse(r("data: " + "x".repeat(5000) + "\n\n"), 1, 1000); fail() } catch (_: IllegalStateException) {}
        try { McpSse.readBounded(StringReader("y".repeat(5000)), 1000); fail() } catch (_: IllegalStateException) {}
        assertEquals("abc", McpSse.readBounded(StringReader("abc"), 1000))
    }

    @Test fun `parseJsonRpcPayload extracts matching id from JSON-RPC batch arrays in both SSE and plain JSON`() {
        val batch = """[{"jsonrpc":"2.0","method":"notifications/progress"},{"jsonrpc":"2.0","id":101,"result":{"v":1}},{"jsonrpc":"2.0","id":102,"result":{"v":2}}]"""
        val match102 = McpSse.parseJsonRpcPayload(batch, 102, strictSingleId = false)
        assertNotNull(match102)
        assertEquals(2, match102!!.getJSONObject("result").getInt("v"))
        assertNull(McpSse.parseJsonRpcPayload(batch, 999, strictSingleId = false))
        val sseBatch = "event: message\ndata: $batch\n\n"
        assertEquals(2, McpSse.readResponse(r(sseBatch), 102, 10_000)!!.getJSONObject("result").getInt("v"))
    }

    @Test fun `renderable app mime types and resource limit`() {
        assertTrue(McpAppPolicy.renderableMime("text/html;profile=mcp-app"))
        assertTrue(McpAppPolicy.renderableMime("text/html+skybridge"))
        assertTrue(McpAppPolicy.renderableMime(""))
        assertFalse(McpAppPolicy.renderableMime("application/octet-stream"))
        assertFalse(McpAppPolicy.renderableMime("image/png"))
        assertTrue(McpAppPolicy.MAX_RESOURCE_CHARS >= 2_400_000)
        assertTrue(McpAppPolicy.validResourceUri("ui://interactive_study_v450.html"))
        assertTrue(McpAppPolicy.validResourceUri("ui://reader_settings_0_1_9_v39.html"))
    }
}
