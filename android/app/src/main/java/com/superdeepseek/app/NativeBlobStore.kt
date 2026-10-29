package com.superdeepseek.app

import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap

/**
 * Streams native data (picked files, shared files, large bridge replies) into
 * the page without Base64, JSON or evaluateJavascript chunks.
 *
 * The native side registers a source and hands the page a same-origin path,
 * `/__sd/blob/<token>`. The page `fetch()`es it; [MainActivity]'s
 * `shouldInterceptRequest` answers from [serve] with the source's InputStream,
 * so the bytes go straight from the ContentResolver into Chromium's blob
 * storage. Same-origin (chat.deepseek.com) keeps CORS and any CSP
 * `connect-src 'self'` out of the way.
 *
 * Tokens are random (128 bit), expire after [ttlMillis] and are never
 * enumerable, so another page cannot read what the user picked.
 */
internal class NativeBlobStore(
        private val ttlMillis: Long = DEFAULT_TTL_MS,
        private val clock: () -> Long = { System.currentTimeMillis() },
) {

    internal class Entry(
            val name: String,
            val mime: String,
            val size: Long,
            val expiresAt: Long,
            /** Served once, then forgotten (bridge replies). */
            val oneShot: Boolean,
            val open: () -> InputStream?,
    )

    private val entries = ConcurrentHashMap<String, Entry>()
    private val random = SecureRandom()

    fun register(
            name: String,
            mime: String,
            size: Long,
            oneShot: Boolean = false,
            open: () -> InputStream?,
    ): String {
        purgeExpired()
        val token = newToken()
        entries[token] = Entry(name, mime.ifBlank { "application/octet-stream" }, size, clock() + ttlMillis, oneShot, open)
        return token
    }

    fun registerBytes(name: String, mime: String, bytes: ByteArray, oneShot: Boolean = false): String =
            register(name, mime, bytes.size.toLong(), oneShot) { ByteArrayInputStream(bytes) }

    fun lookup(token: String): Entry? {
        val entry = entries[token] ?: return null
        if (entry.expiresAt < clock()) {
            entries.remove(token)
            return null
        }
        return entry
    }

    fun remove(token: String) {
        entries.remove(token)
    }

    fun size(): Int = entries.size

    fun purgeExpired() {
        val now = clock()
        entries.entries.removeIf { it.value.expiresAt < now }
    }

    /** The response for a request path, or null when the path is not ours. */
    fun serve(path: String?): WebResourceResponse? {
        val token = parseBlobToken(path) ?: return null
        val entry = lookup(token) ?: return notFound()
        if (entry.oneShot) entries.remove(token)
        val stream =
                try {
                    entry.open()
                } catch (t: Throwable) {
                    null
                } ?: return notFound()
        val headers =
                mutableMapOf(
                        "Cache-Control" to "no-store",
                        "Access-Control-Allow-Origin" to "*",
                        "X-SD-Name" to asciiHeader(entry.name),
                )
        if (entry.size >= 0) headers["X-SD-Size"] = entry.size.toString()
        return WebResourceResponse(entry.mime, null, 200, "OK", headers, stream)
    }

    private fun notFound(): WebResourceResponse =
            WebResourceResponse(
                    "text/plain",
                    "utf-8",
                    404,
                    "Not Found",
                    mapOf("Cache-Control" to "no-store", "Access-Control-Allow-Origin" to "*"),
                    ByteArrayInputStream(ByteArray(0)),
            )

    private fun newToken(): String {
        val bytes = ByteArray(16)
        random.nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    companion object {
        const val PATH_PREFIX = "/__sd/blob/"
        const val DEFAULT_TTL_MS = 30L * 60 * 1000
    }
}

/** `/__sd/blob/<32 hex>` → the token; anything else → null. */
internal fun parseBlobToken(path: String?): String? {
    if (path == null || !path.startsWith(NativeBlobStore.PATH_PREFIX)) return null
    val token = path.substring(NativeBlobStore.PATH_PREFIX.length).substringBefore('/')
    return if (token.length == 32 && token.all { it in '0'..'9' || it in 'a'..'f' }) token else null
}

/** Header values must be ASCII; non-ASCII names are percent-encoded. */
internal fun asciiHeader(value: String): String =
        java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20").take(512)

/**
 * Whether the first bytes of a file look like text: no NUL byte and valid
 * UTF-8 (a multi-byte sequence cut at the end of the sample is allowed).
 */
internal fun looksLikeText(sample: ByteArray, length: Int = sample.size): Boolean {
    var i = 0
    val n = minOf(length, sample.size)
    while (i < n) {
        val b = sample[i].toInt() and 0xFF
        if (b == 0) return false
        val extra =
                when {
                    b < 0x80 -> 0
                    b in 0xC2..0xDF -> 1
                    b in 0xE0..0xEF -> 2
                    b in 0xF0..0xF4 -> 3
                    else -> return false
                }
        if (i + extra >= n) return true // truncated sequence at the end of the sample
        for (k in 1..extra) {
            val c = sample[i + k].toInt() and 0xFF
            if (c and 0xC0 != 0x80) return false
        }
        i += extra + 1
    }
    return true
}
