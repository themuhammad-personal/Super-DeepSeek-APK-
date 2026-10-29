package com.superdeepseek.app

/**
 * Pure MCP Apps host policy (no Android types): URI validation, JSON-RPC method
 * visibility for app Views, tool visibility checks and request-id deduplication.
 *
 * Spec basis: MCP Apps 2026-01-26 — Views may send ui/initialize, ping,
 * tools/call, resources/read and notifications/message. Host MUST reject
 * tools/call for tools without "app" visibility; app-only tools are never
 * cross-server. Host MUST NOT answer before ui/notifications/initialized.
 */
internal object McpAppPolicy {
    /** resourceUri: ui://authority/path or https URL. No user info, no traversal segments. */
    private val RESOURCE_URI = Regex("^(?:ui://[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62})(?:/[A-Za-z0-9_-][A-Za-z0-9._~-]{0,119})*|https://[A-Za-z0-9.-]+(?::\\d{1,5})?/[A-Za-z0-9_-][A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,499})(?:\\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]{0,200})?$")
    private val SERVER_URL = Regex("^https://[A-Za-z0-9.-]+(?::\\d{1,5})?(?:/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,300})?$")

    /** Real MCP App bundles inline their JS/fonts (quran.ai's reader is ~2.3 MB). */
    const val MAX_RESOURCE_CHARS = 8 * 1024 * 1024
    const val MAX_RELAY_CHARS = 256 * 1024
    const val MAX_ID_CHARS = 80

    /** Methods a View may send to this host. Everything else is a JSON-RPC error. */
    private val VIEW_METHODS = setOf(
        "ui/initialize", "ui/notifications/initialized", "ui/notifications/display-mode-changed",
        "ping", "tools/list", "tools/call", "resources/read", "notifications/message"
    )

    /** MIME types renderable as an app View: MCP Apps html profile, plain HTML, and
     *  OpenAI Apps SDK templates (text/html+skybridge). */
    fun renderableMime(mime: String?): Boolean {
        val m = (mime ?: "").trim().lowercase()
        if (m.isEmpty()) return true
        return m.startsWith("text/html") || m.startsWith("text/") || m == "application/json" || m == "application/xhtml+xml"
    }

    fun validResourceUri(uri: String?): Boolean = !uri.isNullOrEmpty() && uri.length <= 900 && RESOURCE_URI.matches(uri)

    fun validServerUrl(url: String?): Boolean = !url.isNullOrEmpty() && url.length <= 400 && SERVER_URL.matches(url)

    fun methodAllowed(method: String?): Boolean = method != null && method.length <= 120 && method in VIEW_METHODS

    /** JSON-RPC id from a View must be string/number, bounded; null when absent/malformed. */
    fun boundedId(id: Any?): String? = when (id) {
        is String -> if (id.isNotEmpty() && id.length <= MAX_ID_CHARS) id else null
        is Number -> if (id.toString().length <= MAX_ID_CHARS) id.toString() else null
        else -> null
    }

    /**
     * A tool is callable from an app View only when its `_meta.ui.visibility`
     * includes "app". Missing visibility defaults to ["model","app"] per spec.
     */
    fun toolCallableFromApp(metaUiVisibility: List<String>?): Boolean {
        if (metaUiVisibility == null) return true
        return metaUiVisibility.contains("app")
    }

    /** Per-viewer request ids: a repeated id never re-executes anything.
     *  Fail-closed when full: unknown ids are refused instead of evicting
     *  old ones, so an evicted id can never re-execute. */
    class RequestLedger(private val max: Int = 512) {
        private val seen = HashSet<String>()
        /** true = first time and capacity remains; false = duplicate or full (never re-run). */
        fun first(id: String): Boolean {
            if (seen.size >= max && id !in seen) return false
            return seen.add(id)
        }
    }

    /** A host can dispatch privileged View requests only after initialized. */
    class Handshake {
        var initialized = false; private set
        fun onInitialize() {}
        fun onInitialized() { initialized = true }
    }

    /** Truncate untrusted relay payloads before persistence/logging. */
    fun bounded(text: String?, limit: Int = MAX_RELAY_CHARS): String? =
        if (text == null) null else if (text.length <= limit) text else text.substring(0, limit)
}
