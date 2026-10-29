package com.superdeepseek.app

/** Pages that may use `window.AndroidBridge`: DeepSeek's chat over https. */
internal fun isTrustedBridgeUrl(url: String?): Boolean {
    if (url.isNullOrBlank()) return false
    val uri = runCatching { java.net.URI(url) }.getOrNull() ?: return false
    return uri.scheme == "https" && uri.host == "chat.deepseek.com" && uri.rawUserInfo == null
}

/** Which page URLs may be reopened after a renderer crash or process restore. */
internal object ChatUrls {
    private val CONVERSATION = Regex("^/a/chat/s/[A-Za-z0-9-]{1,80}/?$")

    /**
     * [url] when it is an open DeepSeek conversation, otherwise null (the app
     * then opens a new chat). Anything else — login pages, other hosts, query
     * strings — is never restored.
     */
    fun restorable(url: String?): String? {
        if (url.isNullOrBlank() || url.length > 200) return null
        val uri = runCatching { java.net.URI(url) }.getOrNull() ?: return null
        if (uri.scheme != "https" || uri.host != "chat.deepseek.com" || uri.port != -1) return null
        if (uri.rawQuery != null || uri.rawFragment != null || uri.rawUserInfo != null) return null
        val path = uri.rawPath ?: return null
        return if (CONVERSATION.matches(path)) "https://chat.deepseek.com$path" else null
    }
}
