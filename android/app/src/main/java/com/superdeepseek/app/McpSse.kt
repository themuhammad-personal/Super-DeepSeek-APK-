package com.superdeepseek.app

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader

/**
 * Streamable-HTTP SSE reader for MCP (spec: Transports, 2025-06-18).
 *
 * Events are separated by a blank line; an event's `data:` lines are joined with
 * "\n". The server may interleave requests/notifications before the response,
 * and may keep the stream open afterwards — so reading stops as soon as the
 * JSON-RPC response with the request's id arrives. Pure JVM; unit-tested.
 */
internal object McpSse {
    private fun idEq(a: Any?, b: Any?): Boolean = a != null && b != null && a.toString() == b.toString()

    /** Returns only a JSON-RPC response correlated to [wantId].
     * A different request's result is never used as a fallback; if no matching
     * response arrives before EOF, returns null. Throws when more than [maxChars] were read.
     */
    fun readResponse(reader: BufferedReader, wantId: Any?, maxChars: Long): JSONObject? {
        val data = StringBuilder()
        var total = 0L
        while (true) {
            val line = reader.readLine()
            if (line == null || line.isEmpty()) {
                if (data.isNotEmpty()) {
                    val text = data.toString(); data.setLength(0)
                    val msg = parseJsonRpcPayload(text, wantId, strictSingleId = true)
                    if (msg != null) return msg
                }
                if (line == null) return null
                continue
            }
            total += line.length + 1
            if (total > maxChars) throw IllegalStateException("MCP response too large")
            if (line.startsWith("data:")) {
                if (data.isNotEmpty()) data.append('\n')
                data.append(if (line.startsWith("data: ")) line.substring(6) else line.substring(5))
            }
            // event:, id:, retry: and ":" comments carry nothing we need.
        }
    }

    /**
     * Parses a JSON-RPC 2.0 response payload (either a single object or a batch array)
     * and selects the message carrying "result" or "error" correlated to [wantId].
     */
    fun parseJsonRpcPayload(raw: String, wantId: Any?, strictSingleId: Boolean = true): JSONObject? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty() || trimmed == "[DONE]") return null
        if (trimmed.startsWith("[")) {
            val arr = runCatching { JSONArray(trimmed) }.getOrNull() ?: return null
            for (i in 0 until arr.length()) {
                val item = arr.optJSONObject(i) ?: continue
                if (item.has("result") || item.has("error")) {
                    if (wantId == null || idEq(item.opt("id"), wantId)) return item
                }
            }
            return null
        }
        val msg = runCatching { JSONObject(trimmed) }.getOrNull() ?: return null
        if (!msg.has("result") && !msg.has("error")) return null
        if (strictSingleId && wantId != null && !idEq(msg.opt("id"), wantId)) return null
        return msg
    }

    /** Reads at most [maxChars] characters; throws beyond that. */
    fun readBounded(reader: java.io.Reader, maxChars: Long): String {
        val sb = StringBuilder()
        val buf = CharArray(16 * 1024)
        while (true) {
            val n = reader.read(buf)
            if (n < 0) return sb.toString()
            if (sb.length + n > maxChars) throw IllegalStateException("MCP response too large")
            sb.append(buf, 0, n)
        }
    }

    const val MAX_RESPONSE_CHARS: Long = 24L * 1024 * 1024
}
