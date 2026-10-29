package com.superdeepseek.app

import java.io.File
import java.util.UUID

/**
 * File handling for generated artifacts handed to native viewers / the share
 * sheet. Pure JVM (unit-testable): bounded sizes, bounded file counts, UUID
 * names only, and nothing outside the app cache directory.
 */
internal object GeneratedApps {
    const val MAX_HTML_CHARS = 1_000_000
    const val MAX_SHARE_BASE64 = 12_000_000 // ≈ 9 MB decoded
    const val KEEP_APPS = 8
    const val KEEP_SHARES = 10
    val SHARE_MIME = setOf("text/html", "image/svg+xml", "image/png", "application/json", "text/csv", "text/plain")

    fun acceptable(doc: String): Boolean = doc.isNotBlank() && doc.length <= MAX_HTML_CHARS

    /** Writes `cache/genui/<uuid>.html` (the id format [GeneratedAppActivity] accepts) and prunes old ones. */
    fun write(cacheDir: File, doc: String): String {
        require(acceptable(doc)) { "unacceptable document" }
        val dir = File(cacheDir, "genui").apply { mkdirs() }
        dir.listFiles()
            ?.filter { it.isFile && it.name.endsWith(".html") && !it.name.endsWith(".mcp.html") }
            ?.sortedByDescending { it.lastModified() }
            ?.drop(KEEP_APPS - 1)
            ?.forEach { it.delete() }
        val id = UUID.randomUUID().toString()
        File(dir, "$id.html").writeText(doc, Charsets.UTF_8)
        return id
    }

    /** Writes `cache/share/<uuid>/<name>`; keeps the newest [KEEP_SHARES] share folders. */
    fun writeShare(cacheDir: File, safeName: String, bytes: ByteArray): File {
        val root = File(cacheDir, "share").apply { mkdirs() }
        root.listFiles()
            ?.filter { it.isDirectory }
            ?.sortedByDescending { it.lastModified() }
            ?.drop(KEEP_SHARES - 1)
            ?.forEach { it.deleteRecursively() }
        val name = safeName.replace(Regex("[^A-Za-z0-9._-]"), "_").trimStart('.').ifEmpty { "artifact" }.take(100)
        val dir = File(root, UUID.randomUUID().toString()).apply { mkdirs() }
        val file = File(dir, name)
        require(file.canonicalPath.startsWith(dir.canonicalPath + File.separator)) { "path escape" }
        file.writeBytes(bytes)
        return file
    }
}
