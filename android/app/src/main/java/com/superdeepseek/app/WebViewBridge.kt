package com.superdeepseek.app

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Vibrator
import android.os.VibratorManager
import android.os.VibrationEffect
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.widget.Toast
import androidx.core.content.FileProvider
import androidx.documentfile.provider.DocumentFile
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.Locale
import java.nio.charset.Charset
import java.util.concurrent.TimeUnit
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

/** File entry returned by the native Android picker to JavaScript. */
internal data class PickedFile(
        val name: String,
        val content: String,
        val encoding: String? = null,
        val mime: String? = null,
        /**
         * Same-origin path (`/__sd/blob/<token>`) the page fetches the bytes from.
         * When set, [content] is empty: nothing is Base64-encoded or copied through
         * evaluateJavascript (see [NativeBlobStore]).
         */
        val blobPath: String? = null,
        val size: Long = -1L,
        /** The bytes are UTF-8 text (the page reads them as a string). */
        val text: Boolean = false,
)

/** Native-picked file that could not be delivered to JavaScript. */
internal data class SkippedFile(val name: String, val reason: String)

internal data class BoundedReadResult(val bytes: ByteArray, val overflowed: Boolean)

internal data class PickReadResult(
        val files: List<PickedFile>,
        val skipped: List<SkippedFile>,
        val folderName: String?,
)

private data class FolderImageCounter(var accepted: Int = 0)

internal sealed class PickedItemResult {
    data class Ok(val file: PickedFile) : PickedItemResult()
    data class Skipped(val name: String, val reason: String) : PickedItemResult()
}

internal fun readBoundedBytes(stream: InputStream, capBytes: Long): BoundedReadResult {
    val output = ByteArrayOutputStream(minOf(capBytes, 8192L).toInt())
    val buffer = ByteArray(8192)
    var total = 0L

    while (true) {
        val remaining = capBytes - total
        val readLimit =
                if (remaining >= buffer.size) buffer.size
                else (remaining + 1).coerceAtLeast(1).toInt()
        val read = stream.read(buffer, 0, readLimit)
        if (read == -1) {
            return BoundedReadResult(output.toByteArray(), overflowed = false)
        }
        if (total + read > capBytes) {
            val keep = (capBytes - total).toInt()
            if (keep > 0) output.write(buffer, 0, keep)
            return BoundedReadResult(output.toByteArray(), overflowed = true)
        }
        output.write(buffer, 0, read)
        total += read
    }
}

internal const val ASYNC_REPLY_INLINE_CHARS = 256 * 1024

internal fun sanitizeCallbackId(raw: String?): String =
        raw?.filter { it.isLetterOrDigit() || it == '-' || it == '_' }?.take(64).orEmpty()

/** Script delivering an async bridge reply: inline when small, as a blob path when large. */
internal fun buildBridgeReplyScript(id: String, result: String, blobs: NativeBlobStore): String {
    val safeId = sanitizeCallbackId(id)
    return if (result.length > ASYNC_REPLY_INLINE_CHARS) {
        val token = blobs.registerBytes("reply.json", "application/json", result.toByteArray(Charsets.UTF_8), oneShot = true)
        "window.__sdBridgeReply&&window.__sdBridgeReply('$safeId',null,'${NativeBlobStore.PATH_PREFIX}$token');"
    } else {
        "window.__sdBridgeReply&&window.__sdBridgeReply('$safeId',${JSONObject.quote(result)},null);"
    }
}

/** Bytes in [stream], stopping at cap + 1 (so a result > cap means "too large"). */
internal fun countStreamBytes(stream: InputStream, cap: Long): Long {
    val buffer = ByteArray(64 * 1024)
    var total = 0L
    while (total <= cap) {
        val read = stream.read(buffer)
        if (read == -1) break
        total += read
    }
    return total
}

internal fun classifyPickedFile(
        name: String,
        byteSize: Long,
        content: String?,
        requireKnownExtension: Boolean,
): PickedItemResult {
    if (hasImageFileExtension(name)) {
        return PickedItemResult.Skipped(name, "image-requires-vision")
    }
    if (byteSize > WebViewBridge.MAX_PICKED_FILE_SIZE) {
        return PickedItemResult.Skipped(name, "too-large")
    }
    if (content == null) {
        return PickedItemResult.Skipped(name, "unreadable")
    }
    if (content.toByteArray(Charsets.UTF_8).size > WebViewBridge.MAX_PICKED_FILE_SIZE) {
        return PickedItemResult.Skipped(name, "too-large")
    }

    val hasKnownExtension = hasTextFileExtension(name)
    val hasNul = content.any { it.code == 0 }
    if (hasKnownExtension) {
        return if (hasNul) {
            PickedItemResult.Skipped(name, "binary")
        } else {
            PickedItemResult.Ok(PickedFile(name, content))
        }
    }

    if (requireKnownExtension || hasNul) {
        return PickedItemResult.Skipped(name, "unsupported-type")
    }
    return PickedItemResult.Ok(PickedFile(name, content))
}

internal fun compressImageIfNeeded(
        bytes: ByteArray,
        maxDim: Int = 2048,
        quality: Int = 85,
        forceJpeg: Boolean = false,
): ByteArray {
    try {
        val options = android.graphics.BitmapFactory.Options().apply {
            inJustDecodeBounds = true
        }
        android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        val origWidth = options.outWidth
        val origHeight = options.outHeight

        if (origWidth <= 0 || origHeight <= 0) return bytes

        if (!forceJpeg && origWidth <= maxDim && origHeight <= maxDim && bytes.size < 1_500_000) {
            return bytes
        }

        var sampleSize = 1
        while (origWidth / sampleSize > maxDim || origHeight / sampleSize > maxDim) {
            sampleSize *= 2
        }

        val decodeOptions = android.graphics.BitmapFactory.Options().apply {
            inSampleSize = sampleSize
        }
        val bitmap = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, decodeOptions)
            ?: return bytes

        val outStream = java.io.ByteArrayOutputStream()
        bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, quality, outStream)
        bitmap.recycle()
        return outStream.toByteArray()
    } catch (e: Throwable) {
        return bytes
    }
}

internal fun encodePickedImage(
        name: String,
        bytes: ByteArray,
        capBytes: Long = WebViewBridge.MAX_PICKED_IMAGE_SIZE,
        forceJpeg: Boolean = false,
): PickedItemResult {
    val processedBytes = compressImageIfNeeded(bytes, forceJpeg = forceJpeg)
    if (processedBytes.size.toLong() > capBytes) {
        return PickedItemResult.Skipped(name, "too-large")
    }
    return PickedItemResult.Ok(
            PickedFile(
                    name = name,
                    content = java.util.Base64.getEncoder().encodeToString(processedBytes),
                    encoding = "base64",
                    mime = mimeForImageName(name),
            )
    )
}

/**
 * Gallery/camera URIs don't always carry a supported image extension
 * (`media/1234`, `IMG_1.heic`). When the provider reports an image MIME type,
 * returns the name to deliver it under plus whether it must be re-encoded to
 * JPEG (formats the chat can't take, e.g. HEIC/AVIF). Null when not an image.
 */
internal fun imagePickNameForMime(name: String, mime: String?): Pair<String, Boolean>? {
    val type = mime?.lowercase()?.substringBefore(';')?.trim() ?: return null
    if (!type.startsWith("image/")) return null
    val base = name.substringBeforeLast('.', name).ifBlank { "image" }
    val ext = WebViewBridge.IMAGE_MIME_TYPES.entries.firstOrNull { it.value == type }?.key
    return if (ext != null) "$base.$ext" to false else "$base.jpg" to true
}

internal fun mimeForImageName(name: String): String {
    val ext = fileExtension(name)
    return WebViewBridge.IMAGE_MIME_TYPES[ext] ?: "application/octet-stream"
}

internal fun hasDocumentFileExtension(name: String): Boolean =
        WebViewBridge.DOCUMENT_MIME_TYPES.containsKey(fileExtension(name))

internal fun mimeForDocumentName(name: String): String =
        WebViewBridge.DOCUMENT_MIME_TYPES[fileExtension(name)] ?: "application/octet-stream"

internal fun encodePickedDocument(
        name: String,
        bytes: ByteArray,
        mime: String,
        capBytes: Long = WebViewBridge.MAX_PICKED_FILE_SIZE,
): PickedItemResult {
    if (bytes.size.toLong() > capBytes) {
        return PickedItemResult.Skipped(name, "too-large")
    }
    return PickedItemResult.Ok(
            PickedFile(
                    name = name,
                    content = java.util.Base64.getEncoder().encodeToString(bytes),
                    encoding = "base64",
                    mime = mime,
            )
    )
}

internal fun classifyFolderImageCap(name: String, acceptedImageCount: Int): PickedItemResult? {
    return if (acceptedImageCount >= WebViewBridge.MAX_FOLDER_IMAGES) {
        PickedItemResult.Skipped(name, "image-cap-exceeded")
    } else {
        null
    }
}

internal fun buildPickResultScripts(requestId: String, payloadJson: String): List<String> {
    val safeId = sanitizePickRequestId(requestId)
    if (safeId.isEmpty()) return emptyList()

    val chunks =
            if (payloadJson.isEmpty()) listOf("")
            else payloadJson.chunked(WebViewBridge.MAX_PICK_CHUNK_CHARS)
    val total = chunks.size
    return chunks.mapIndexed { index, chunk ->
        val dataLiteral = JSONObject.quote(chunk)
        "(function(){try{window.dispatchEvent(new CustomEvent('__bds_native_files_picked_$safeId'," +
                "{detail:{v:2,kind:'chunk',seq:$index,total:$total,data:$dataLiteral}}));}" +
                "catch(e){console.error('[BDS] pick delivery failed',e)}})();"
    }
}

private fun sanitizePickRequestId(requestId: String): String =
        requestId.filter { it.isLetterOrDigit() || it == '-' }.take(64)

private fun hasTextFileExtension(filename: String): Boolean {
    val ext = fileExtension(filename)
    return ext.isNotEmpty() && ext in WebViewBridge.TEXT_EXTENSIONS
}

private fun hasImageFileExtension(filename: String): Boolean {
    val ext = fileExtension(filename)
    return ext.isNotEmpty() && ext in WebViewBridge.IMAGE_EXTENSIONS
}

private fun fileExtension(filename: String): String =
        filename.substringAfterLast('.', "").lowercase()

/**
 * @JavascriptInterface object exposed to the WebView as `window.AndroidBridge`.
 *
 * It backs the engine injected into chat.deepseek.com: key/value storage (prefs plus
 * [EngineStore] for large values), the native file/folder/camera picker (files streamed through
 * [NativeBlobStore]), downloads, CORS-free fetch / GitHub / MCP calls, haptics and the built-in
 * Linux sandbox. Every method MUST be safe to call from arbitrary JS — inputs are validated and
 * JSON strings (or null) are returned rather than thrown — and the sensitive ones refuse to serve
 * any page but https://chat.deepseek.com ([trustedPage]).
 */
class WebViewBridge(
        private val context: Context,
        httpClient: OkHttpClient? = null,
        private val githubApiBaseUrl: String = DEFAULT_GITHUB_API_BASE_URL,
        private val allowLoopbackFetchUrl: Boolean = httpClient != null,
) {

    private val prefs: SharedPreferences =
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** Picked/shared files and large replies, streamed to the page by URL. */
    internal val blobs = NativeBlobStore()

    /** Large engine storage values (see [EngineStore]); small ones stay in [prefs]. */
    private val engineStoreLazy = lazy {
        val dir = runCatching { context.filesDir }.getOrNull()?.let { File(it, "engine-store") }
        EngineStore(dir).also { store -> moveLargePrefsToStore(store) }
    }
    internal val engineStore: EngineStore by engineStoreLazy

    /** Called when the app goes to the background: write pending values now. */
    fun flushStorageSoon() {
        if (engineStoreLazy.isInitialized()) engineStore.flushSoon()
    }

    /** One-time move of large values out of the SharedPreferences file. */
    private fun moveLargePrefsToStore(store: EngineStore) {
        try {
            val large = prefs.all?.filter { (_, v) -> v is String && v.length > EngineStore.LARGE_VALUE_CHARS } ?: return
            if (large.isEmpty()) return
            large.forEach { (k, v) -> store.put(k, v as String) }
            store.flushNow()
            val editor = prefs.edit()
            large.keys.forEach { editor.remove(it) }
            editor.apply()
        } catch (t: Throwable) {
            Log.w(TAG, "moving large storage values failed", t)
        }
    }

    private val httpClient: OkHttpClient =
            httpClient
                    ?: OkHttpClient.Builder()
                            .connectTimeout(20, TimeUnit.SECONDS)
                            .readTimeout(60, TimeUnit.SECONDS)
                            .callTimeout(120, TimeUnit.SECONDS)
                            .build()

    /** SSRF-safe client for bds-fetch-url (Deep Research / web search / URL reader). */
    private val publicFetchClient: OkHttpClient by lazy {
        val base = this.httpClient.newBuilder()
            .cookieJar(okhttp3.CookieJar.NO_COOKIES)
            .cache(null)
        if (allowLoopbackFetchUrl) {
            base.build()
        } else {
            base.dns(FrameFetchPolicy.SafeDns())
                .proxy(java.net.Proxy.NO_PROXY)
                .addNetworkInterceptor(FrameFetchPolicy.HopGuard)
                .followRedirects(true)
                .followSslRedirects(true)
                .build()
        }
    }

    /** Set by MainActivity to react to page theme changes without leaking the Activity window. */
    @Volatile var onThemeChanged: ((isDark: Boolean) -> Unit)? = null

    /**
     * Set by MainActivity to evaluate JS in the WebView. Results from native picker launchers
     * are delivered through CustomEvent instances in the page.
     */
    @Volatile var evaluateJs: ((script: String) -> Unit)? = null

    /** Test hook for unit tests that cannot rely on Android's main looper. */
    @Volatile internal var scriptPoster: ((String) -> Unit)? = null

    /**
     * Set by MainActivity to launch the native file or folder picker.
     * Mode is "files" or "folder"; requestId is the JS correlation key.
     */
    @Volatile var onPickFiles: ((mode: String, requestId: String) -> Unit)? = null

    /**
     * Set by MainActivity: fired when the injected engine signals that its UI
     * (drawer, panels, polish pass) is mounted and ready — the native boot
     * overlay waits for this before revealing the app.
     */
    @Volatile var onUiPolishedCallback: (() -> Unit)? = null

    /**
     * Returns the last DeepSeek page theme written by the extension's theme.js via
     * chrome.storage.local (which the Android polyfill routes through [setStorage] as
     * JSON.stringify(boolean) → stored as the string "true" or "false"). Falls back to [default]
     * on first-ever launch before any value has been persisted.
     */
    fun getLastKnownIsDark(default: Boolean = false): Boolean {
        val raw = prefs.getString(KEY_LAST_PAGE_DARK, null) ?: return default
        return raw == "true"
    }

    /**
     * Called by theme.js (via AndroidBridge.reportTheme) when the page's light/dark state changes.
     * Persistence is handled cross-platform by chrome.storage.local.set in theme.js; this method
     * exists solely so MainActivity can update status/navigation bar icon colours immediately.
     */
    @JavascriptInterface
    fun reportTheme(isDark: Boolean) {
        onThemeChanged?.invoke(isDark)
    }

    /** Returns the Android system locale for JS locale detection inside WebView. */
    @JavascriptInterface
    fun getSystemLocale(): String {
        val tag = Locale.getDefault().toLanguageTag()
        return if (tag.isNotBlank() && tag != "und") tag else "en-US"
    }

    /**
     * Called by JS to open the native Android file or folder picker.
     *
     * The result is delivered asynchronously as a page CustomEvent named
     * "__bds_native_files_picked_<requestId>".
     */
    @JavascriptInterface
    fun pickFiles(mode: String?, requestId: String?) {
        if (!trustedPage) return
        val safeId =
                requestId
                        ?.let(::sanitizePickRequestId)
                        ?: return
        if (safeId.isEmpty()) return

        val safeMode =
                when (mode) {
                    "camera", "images", "folder", "folder+images", "files+images" -> mode
                    else -> "files"
                }
        val handler = onPickFiles
        if (handler == null) {
            deliverPickError(safeId, "picker-launch-failed")
            return
        }
        handler.invoke(safeMode, safeId)
    }

    internal fun deliverPickedFiles(
            requestId: String,
            files: List<PickedFile>,
            skipped: List<SkippedFile>,
            folderName: String?
    ) {
        val filesJson = JSONArray()
        for (file in files) {
            filesJson.put(
                    JSONObject().apply {
                        put("name", file.name)
                        put("content", file.content)
                        if (file.encoding != null) put("encoding", file.encoding)
                        if (file.mime != null) put("mime", file.mime)
                        if (file.blobPath != null) {
                            put("blob", file.blobPath)
                            put("size", file.size)
                            put("text", file.text)
                        }
                    }
            )
        }
        val skippedJson = JSONArray()
        for (file in skipped) {
            skippedJson.put(
                    JSONObject().apply {
                        put("name", file.name)
                        put("reason", file.reason)
                    }
            )
        }
        val payload =
                JSONObject().apply {
                    put("files", filesJson)
                    put("skipped", skippedJson)
                    if (folderName != null) put("folderName", folderName)
                }
        deliverPickResult(requestId, payload)
    }

    internal fun deliverPickError(requestId: String, error: String) {
        val payload =
                JSONObject().apply {
                    put("error", error)
                    put("files", JSONArray())
                }
        deliverPickResult(requestId, payload)
    }

    internal fun deliverPickStatus(requestId: String, phase: String) {
        val safeId = sanitizePickRequestId(requestId)
        if (safeId.isEmpty()) return
        val safePhase = phase.filter { it.isLetter() || it == '-' }.take(32)
        if (safePhase.isEmpty()) return
        val script =
                "(function(){try{window.dispatchEvent(new CustomEvent('__bds_native_files_picked_$safeId'," +
                        "{detail:{v:2,kind:'status',phase:'$safePhase'}}));}" +
                        "catch(e){console.error('[BDS] pick delivery failed',e)}})();"
        postScript(script)
    }

    private fun deliverPickResult(requestId: String, payload: JSONObject) {
        buildPickResultScripts(requestId, payload.toString()).forEach(::postScript)
    }

    private fun postScript(script: String) {
        val poster = scriptPoster
        if (poster != null) {
            poster(script)
            return
        }
        mainHandler.post { evaluateJs?.invoke(script) }
    }

    /**
     * Reads several picked URIs, a few at a time (image compression and
     * content sniffing are the slow parts), keeping the pick order.
     */
    internal fun readPickedContentUris(uris: List<Uri>, acceptImages: Boolean): Pair<List<PickedFile>, List<SkippedFile>> {
        val results = arrayOfNulls<PickedItemResult>(uris.size)
        if (uris.size <= 1) {
            uris.forEachIndexed { i, uri -> results[i] = readPickedContentUriSafely(uri, acceptImages) }
        } else {
            val pool = java.util.concurrent.Executors.newFixedThreadPool(minOf(PICK_READ_PARALLELISM, uris.size))
            try {
                val futures = uris.map { uri -> pool.submit<PickedItemResult> { readPickedContentUriSafely(uri, acceptImages) } }
                futures.forEachIndexed { i, f -> results[i] = f.get() }
            } finally {
                pool.shutdown()
            }
        }
        val files = ArrayList<PickedFile>()
        val skipped = ArrayList<SkippedFile>()
        for (r in results) {
            when (r) {
                is PickedItemResult.Ok -> files.add(r.file)
                is PickedItemResult.Skipped -> skipped.add(SkippedFile(r.name, r.reason))
                null -> {}
            }
        }
        return files to skipped
    }

    private fun readPickedContentUriSafely(uri: Uri, acceptImages: Boolean): PickedItemResult =
            try {
                readPickedContentUri(uri, acceptImages)
            } catch (t: Throwable) {
                Log.w(TAG, "Picked file unreadable: $uri", t)
                PickedItemResult.Skipped(uri.lastPathSegment?.substringAfterLast('/') ?: "file", "unreadable")
            }

    internal fun readPickedContentUri(uri: Uri, acceptImages: Boolean = false): PickedItemResult {
        val name = resolvePickedDisplayName(uri)
        if (hasImageFileExtension(name)) {
            if (!acceptImages) {
                return PickedItemResult.Skipped(name, "image-requires-vision")
            }
            return readPickedImageUri(uri, name)
        }

        val providerMime = runCatching { context.contentResolver.getType(uri) }.getOrNull()
        if (acceptImages && !hasDocumentFileExtension(name) && !hasTextFileExtension(name)) {
            imagePickNameForMime(name, providerMime)?.let { (imageName, forceJpeg) ->
                return readPickedImageUri(uri, imageName, forceJpeg)
            }
        }

        if (hasDocumentFileExtension(name)) {
            return readPickedDocumentUri(uri, name, mimeForDocumentName(name))
        }
        return streamPickedUri(uri, name, providerMime)
    }

    internal fun readPickedDocumentUri(uri: Uri, name: String, mime: String): PickedItemResult =
            registerStreamedFile(uri, name, mime, text = false, cap = MAX_PICKED_BLOB_SIZE)

    /**
     * Any other file: text (by content, not only by extension) is delivered as
     * text, everything else as a binary file — the page decides what to do with
     * it. Neither is read into memory here; the page streams the bytes.
     */
    private fun streamPickedUri(uri: Uri, name: String, providerMime: String?): PickedItemResult {
        val sample =
                try {
                    context.contentResolver.openInputStream(uri)?.use { stream ->
                        readBoundedBytes(stream, TEXT_SNIFF_BYTES.toLong()).bytes
                    }
                } catch (t: Throwable) {
                    Log.w(TAG, "streamPickedUri: cannot open $uri", t)
                    null
                } ?: return PickedItemResult.Skipped(name, "unreadable")
        val isText = looksLikeText(sample)
        val mime =
                if (isText) "text/plain"
                else providerMime?.takeIf { it.isNotBlank() && it != "*/*" } ?: guessMimeForName(name)
        return registerStreamedFile(
                uri,
                name,
                mime,
                text = isText,
                // Streamed (never held in memory): text gets the same 100 MB ceiling as
                // binaries; the page splits huge text into parts before uploading.
                cap = MAX_PICKED_BLOB_SIZE,
        )
    }

    /** Checks the size (counting the stream when the provider does not say) and registers a blob. */
    private fun registerStreamedFile(
            uri: Uri,
            name: String,
            mime: String,
            text: Boolean,
            cap: Long,
    ): PickedItemResult {
        var length = runCatching { getContentLength(uri) }.getOrDefault(-1L)
        if (length > cap) return PickedItemResult.Skipped(name, "too-large")
        if (length < 0) {
            length =
                    try {
                        context.contentResolver.openInputStream(uri)?.use { countStreamBytes(it, cap) }
                    } catch (t: Throwable) {
                        Log.w(TAG, "registerStreamedFile: cannot measure $uri", t)
                        null
                    } ?: return PickedItemResult.Skipped(name, "unreadable")
            if (length > cap) return PickedItemResult.Skipped(name, "too-large")
        }
        val resolver = context.contentResolver
        val token = blobs.register(name, mime, length) { resolver.openInputStream(uri) }
        return PickedItemResult.Ok(
                PickedFile(
                        name = name,
                        content = "",
                        encoding = if (text) null else "base64",
                        mime = mime,
                        blobPath = NativeBlobStore.PATH_PREFIX + token,
                        size = length,
                        text = text,
                )
        )
    }

    /** Image bytes (already size-checked and compressed) as a streamed blob. */
    private fun blobPickedImage(name: String, bytes: ByteArray, forceJpeg: Boolean = false): PickedItemResult {
        val processed = compressImageIfNeeded(bytes, forceJpeg = forceJpeg)
        if (processed.size.toLong() > MAX_PICKED_IMAGE_SIZE) return PickedItemResult.Skipped(name, "too-large")
        val mime = mimeForImageName(name)
        val token = blobs.registerBytes(name, mime, processed)
        return PickedItemResult.Ok(
                PickedFile(
                        name = name,
                        content = "",
                        encoding = "base64",
                        mime = mime,
                        blobPath = NativeBlobStore.PATH_PREFIX + token,
                        size = processed.size.toLong(),
                )
        )
    }

    private fun guessMimeForName(name: String): String =
            android.webkit.MimeTypeMap.getSingleton()
                    .getMimeTypeFromExtension(fileExtension(name))
                    ?: "application/octet-stream"

    internal fun readPickedFolderTree(treeUri: Uri, acceptImages: Boolean = false): PickReadResult {
        val docTree = DocumentFile.fromTreeUri(context, treeUri)
                ?: return PickReadResult(emptyList(), emptyList(), "folder")
        val folderName = docTree.name ?: "folder"
        val files = mutableListOf<PickedFile>()
        val skipped = mutableListOf<SkippedFile>()
        val imageCounter = FolderImageCounter()
        traverseDocumentTree(docTree, "", files, skipped, 0, acceptImages, imageCounter)
        return PickReadResult(files, skipped, folderName)
    }

    internal fun resolvePickedDisplayName(uri: Uri): String {
        runCatching { getDisplayName(uri) }
                .getOrNull()
                ?.trim()
                ?.takeIf { it.isNotEmpty() }
                ?.let { return it }

        runCatching { DocumentFile.fromSingleUri(context, uri)?.name }
                .getOrNull()
                ?.trim()
                ?.takeIf { it.isNotEmpty() }
                ?.let { return it }

        val parsed =
                uri.lastPathSegment
                        ?.let(Uri::decode)
                        ?.substringAfterLast('/')
                        ?.substringAfterLast(':')
                        ?.trim()
        if (!parsed.isNullOrEmpty()) return parsed
        return "picked_file.txt"
    }

    private fun traverseDocumentTree(
            dir: DocumentFile,
            pathPrefix: String,
            out: MutableList<PickedFile>,
            skipped: MutableList<SkippedFile>,
            depth: Int,
            acceptImages: Boolean,
            imageCounter: FolderImageCounter,
    ) {
        if (depth > MAX_FOLDER_DEPTH) return
        for (child in dir.listFiles()) {
            val name = child.name
            if (name == null) {
                if (child.isFile) skipped.add(SkippedFile("unknown", "unreadable"))
                continue
            }
            val relPath = if (pathPrefix.isEmpty()) name else "$pathPrefix/$name"
            if (isSkippedPath(relPath)) continue
            if (child.isDirectory) {
                traverseDocumentTree(child, relPath, out, skipped, depth + 1, acceptImages, imageCounter)
            } else if (child.isFile) {
                if (out.size >= MAX_FOLDER_FILES) {
                    skipped.add(SkippedFile(relPath, "file-cap-exceeded"))
                    continue
                }
                when (val picked = readDocumentFile(child, relPath, acceptImages, imageCounter)) {
                    is PickedItemResult.Ok -> out.add(picked.file)
                    is PickedItemResult.Skipped -> skipped.add(SkippedFile(picked.name, picked.reason))
                }
            }
        }
    }

    private fun readDocumentFile(
            file: DocumentFile,
            relPath: String,
            acceptImages: Boolean,
            imageCounter: FolderImageCounter,
    ): PickedItemResult {
        val name = file.name ?: return PickedItemResult.Skipped(relPath, "unreadable")
        if (hasImageFileExtension(name)) {
            if (!acceptImages) {
                return PickedItemResult.Skipped(relPath, "image-requires-vision")
            }
            classifyFolderImageCap(relPath, imageCounter.accepted)?.let { return it }
            return readPickedImageDocument(file, relPath).also { result ->
                if (result is PickedItemResult.Ok) imageCounter.accepted += 1
            }
        }
        val knownText = isTextFileExtension(name)
        val length = file.length()
        // Unknown extensions (Makefile, LICENSE, .conf …) are accepted when they
        // are small and their content is text; big unknown files are skipped.
        if (!knownText && length > MAX_UNKNOWN_FOLDER_FILE_SIZE) {
            return PickedItemResult.Skipped(relPath, "unsupported-type")
        }
        if (length > MAX_PICKED_FILE_SIZE) {
            return PickedItemResult.Skipped(relPath, "too-large")
        }
        val sample =
                try {
                    context.contentResolver.openInputStream(file.uri)?.use { stream ->
                        readBoundedBytes(stream, TEXT_SNIFF_BYTES.toLong()).bytes
                    }
                } catch (t: Throwable) {
                    Log.w(TAG, "readDocumentFile failed for $relPath", t)
                    null
                } ?: return PickedItemResult.Skipped(relPath, "unreadable")
        if (!looksLikeText(sample)) {
            return PickedItemResult.Skipped(relPath, if (knownText) "binary" else "unsupported-type")
        }
        val resolver = context.contentResolver
        val uri = file.uri
        val token = blobs.register(relPath, "text/plain", length) { resolver.openInputStream(uri) }
        return PickedItemResult.Ok(
                PickedFile(
                        name = relPath,
                        content = "",
                        mime = "text/plain",
                        blobPath = NativeBlobStore.PATH_PREFIX + token,
                        size = length,
                        text = true,
                )
        )
    }

    private fun readPickedImageUri(uri: Uri, name: String, forceJpeg: Boolean = false): PickedItemResult {
        val length = runCatching { getContentLength(uri) }.getOrDefault(-1L)
        if (length > MAX_PICKED_IMAGE_SIZE) {
            return PickedItemResult.Skipped(name, "too-large")
        }
        val bytes =
                try {
                    context.contentResolver.openInputStream(uri)?.use { stream ->
                        val read = readBoundedBytes(stream, MAX_PICKED_IMAGE_SIZE)
                        if (read.overflowed) {
                            return PickedItemResult.Skipped(name, "too-large")
                        }
                        read.bytes
                    }
                } catch (t: Throwable) {
                    Log.w(TAG, "readPickedImageUri failed for $uri", t)
                    null
                }
        return if (bytes == null) {
            PickedItemResult.Skipped(name, "unreadable")
        } else {
            blobPickedImage(name, bytes, forceJpeg = forceJpeg)
        }
    }

    private fun readPickedImageDocument(file: DocumentFile, relPath: String): PickedItemResult {
        val length = file.length()
        if (length > MAX_PICKED_IMAGE_SIZE) {
            return PickedItemResult.Skipped(relPath, "too-large")
        }
        val bytes =
                try {
                    context.contentResolver.openInputStream(file.uri)?.use { stream ->
                        val read = readBoundedBytes(stream, MAX_PICKED_IMAGE_SIZE)
                        if (read.overflowed) {
                            return PickedItemResult.Skipped(relPath, "too-large")
                        }
                        read.bytes
                    }
                } catch (t: Throwable) {
                    Log.w(TAG, "readPickedImageDocument failed for $relPath", t)
                    null
                }
        return if (bytes == null) {
            PickedItemResult.Skipped(relPath, "unreadable")
        } else {
            blobPickedImage(relPath, bytes)
        }
    }

    private fun getDisplayName(uri: Uri): String? =
            context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (!cursor.moveToFirst() || index < 0) null else cursor.getString(index)
            }

    private fun getContentLength(uri: Uri): Long =
            context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                val index = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (!cursor.moveToFirst() || index < 0 || cursor.isNull(index)) -1L
                else cursor.getLong(index)
            } ?: -1L

    private fun isTextFileExtension(filename: String): Boolean = hasTextFileExtension(filename)

    private fun isSkippedPath(relPath: String): Boolean =
            relPath.split("/").any { it in SKIP_DIRS }

    @JavascriptInterface
    fun getStorage(key: String?): String? {
        if (!trustedPage) return null
        if (key.isNullOrEmpty()) return null
        return engineStore.get(key) ?: prefs.getString(key, null)
    }

    @JavascriptInterface
    fun setStorage(key: String?, value: String?) {
        if (!trustedPage) return
        if (key.isNullOrEmpty()) return
        val v = value ?: ""
        if (v.length > EngineStore.LARGE_VALUE_CHARS) {
            engineStore.put(key, v)
            if (prefs.contains(key)) prefs.edit().remove(key).apply()
        } else {
            if (engineStore.has(key)) engineStore.remove(key)
            prefs.edit().putString(key, v).apply()
        }
    }

    @JavascriptInterface
    fun removeStorage(key: String?) {
        if (!trustedPage) return
        if (key.isNullOrEmpty()) return
        engineStore.remove(key)
        prefs.edit().remove(key).apply()
    }

    @JavascriptInterface
    fun getAssetUrl(relativePath: String?): String {
        val authority = context.getString(R.string.bds_asset_authority)
        val cleaned = (relativePath ?: "").trimStart('/')
        return "https://$authority/bds/$cleaned"
    }

    /**
     * Decode a base64 blob produced by the JS download helpers and write it to the user's Downloads
     * folder.
     *
     * Strategy:
     * - API 29+ (Q): insert into MediaStore.Downloads (pending until fully written).
     * - API 26-28: write into the shared Downloads folder, or the app's own one until the storage
     *   permission is granted ([LegacyDownloads]); then offer ACTION_VIEW via FileProvider.
     *
     * The JS side is fire-and-forget; failures are logged and surfaced as a Toast so the user is
     * never left wondering why the download didn't appear.
     */
    @JavascriptInterface
    fun downloadBlob(base64: String?, mimeType: String?, fileName: String?) {
        if (!trustedPage) return
        val payload = base64?.takeIf { it.isNotEmpty() }
        if (payload == null) {
            Log.w(TAG, "downloadBlob: empty payload, ignoring (name=$fileName)")
            return
        }

        val safeName = sanitizeDownloadName(fileName)
        val resolvedMime = mimeType?.takeIf { it.isNotBlank() } ?: "application/octet-stream"
        runCatching { onDownloadRequested?.invoke() }
        // Decode and write off the JS thread: a large ZIP used to freeze the page
        // until the file was on disk.
        ioExecutor.execute { saveDownload(payload, safeName, resolvedMime) }
    }

    /** Set by the activity: a download is starting (Android 8–9 asks for storage access once). */
    @Volatile var onDownloadRequested: (() -> Unit)? = null

    private fun saveDownload(payload: String, safeName: String, resolvedMime: String) {
        try {
            val bytes = Base64.decode(payload, Base64.DEFAULT)
            val uri = writeBytesToDownloads(bytes, safeName, resolvedMime)
            if (uri == null) {
                showToast("Download failed: $safeName")
                return
            }

            showToast("Saved: $safeName")
            tryLaunchViewer(uri, resolvedMime)
        } catch (t: Throwable) {
            Log.e(TAG, "downloadBlob failed for $safeName", t)
            showToast("Download error: ${t.message ?: "unknown"}")
        }
    }

    /**
     * Perform native physical haptic vibration for crisp Android touch interaction.
     */
    @JavascriptInterface
    fun performHaptic(type: String?) {
        try {
            val vibrator =
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        val manager =
                                context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE)
                                        as? VibratorManager
                        manager?.defaultVibrator
                    } else {
                        @Suppress("DEPRECATION")
                        context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
                    } ?: return

            if (!vibrator.hasVibrator()) return

            run {
                val effect =
                        when (type?.lowercase()) {
                            "heavy" ->
                                    VibrationEffect.createOneShot(45, VibrationEffect.DEFAULT_AMPLITUDE)
                            "error" ->
                                    VibrationEffect.createWaveform(longArrayOf(0, 30, 60, 45), -1)
                            "success" ->
                                    VibrationEffect.createWaveform(longArrayOf(0, 15, 60, 20), -1)
                            "message_sent" ->
                                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                                        VibrationEffect.createPredefined(VibrationEffect.EFFECT_CLICK)
                                    } else {
                                        VibrationEffect.createOneShot(18, 180)
                                    }
                            "tick" ->
                                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                                        VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK)
                                    } else {
                                        VibrationEffect.createOneShot(10, 120)
                                    }
                            "medium" ->
                                    VibrationEffect.createOneShot(22, VibrationEffect.DEFAULT_AMPLITUDE)
                            else ->
                                    VibrationEffect.createOneShot(12, VibrationEffect.DEFAULT_AMPLITUDE)
                        }
                vibrator.vibrate(effect)
            }
        } catch (_: Throwable) {
            // Silently ignore if device does not support vibration
        }
    }

    /**
     * Simple duration-based vibration (`AndroidBridge.vibrate(ms)`). Clamped so a
     * page script can never hold the motor.
     */
    @JavascriptInterface
    fun vibrate(millis: Long) {
        val ms = millis.coerceIn(1, 60)
        try {
            val vibrator =
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        val manager =
                                context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE)
                                        as? VibratorManager
                        manager?.defaultVibrator
                    } else {
                        @Suppress("DEPRECATION")
                        context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
                    } ?: return
            if (!vibrator.hasVibrator()) return
            vibrator.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
        } catch (_: Throwable) {
            // Device without a vibrator — haptics are optional polish.
        }
    }

    private fun writeBytesToDownloads(
            bytes: ByteArray,
            fileName: String,
            mimeType: String,
    ): Uri? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val resolver = context.contentResolver
            val values =
                    ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, fileName)
                        put(MediaStore.Downloads.MIME_TYPE, mimeType)
                        put(MediaStore.Downloads.IS_PENDING, 1)
                    }
            val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            val itemUri = resolver.insert(collection, values) ?: return null
            try {
                resolver.openOutputStream(itemUri)?.use { it.write(bytes) }
                        ?: throw java.io.IOException("could not open the download for writing")
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                resolver.update(itemUri, values, null, null)
            } catch (t: Throwable) {
                // A failed write must not leave a hidden, half-written pending entry behind.
                runCatching { resolver.delete(itemUri, null, null) }
                throw t
            }
            itemUri
        } else {
            val file = uniqueFileIn(LegacyDownloads.folder(context), fileName)
            FileOutputStream(file).use { it.write(bytes) }

            val authority = "${context.packageName}.fileprovider"
            try {
                FileProvider.getUriForFile(context, authority, file)
            } catch (t: Throwable) {
                Log.w(TAG, "FileProvider URI failed; falling back to file scheme", t)
                Uri.fromFile(file)
            }
        }
    }

    private fun tryLaunchViewer(uri: Uri, mimeType: String) {
        mainHandler.post {
            runCatching {
                val intent =
                        Intent(Intent.ACTION_VIEW).apply {
                            setDataAndType(uri, mimeType)
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        }
                context.startActivity(intent)
            }
                    .onFailure { Log.i(TAG, "No viewer for $mimeType — file remains in Downloads") }
        }
    }

    private fun sanitizeDownloadName(fileName: String?): String {
        val raw = fileName?.trim().orEmpty().ifEmpty { "download.bin" }
        // Strip path separators and characters Android FS rejects. Mirrors
        // flattenPathForDownload() in src/lib/utils/download.js.
        return raw.replace('/', '_').replace('\\', '_').replace(Regex("[<>:\"|?*]"), "_").take(200)
    }

    private val mainHandler = Handler(Looper.getMainLooper())

    private fun showToast(message: String) {
        mainHandler.post {
            runCatching { Toast.makeText(context, message, Toast.LENGTH_SHORT).show() }
        }
    }

    /** Background pool for bridge work that must not block the page's JS thread. */
    private val ioExecutor = java.util.concurrent.Executors.newFixedThreadPool(IO_THREADS)

    /**
     * Non-blocking [fetch]. `fetch()` is a synchronous @JavascriptInterface call,
     * so a slow site, a GitHub zip or an MCP call froze the whole chat (JS thread
     * blocked) for its full duration. The reply arrives through
     * `window.__sdBridgeReply(id, json, blobPath)`; replies larger than
     * [ASYNC_REPLY_INLINE_CHARS] are streamed via [blobs] instead of being
     * pushed through evaluateJavascript.
     */
    @JavascriptInterface
    fun fetchAsync(payloadJson: String?, callbackId: String?) {
        if (!trustedPage) return
        val id = sanitizeCallbackId(callbackId)
        if (id.isEmpty()) return
        // Sandbox commands can run for many minutes: give them their own
        // threads so they never starve page fetches (and vice versa).
        val executor = if (isSandboxPayload(payloadJson)) sandboxExecutor else ioExecutor
        executor.execute {
            val result = fetch(payloadJson)
            postScript(buildBridgeReplyScript(id, result, blobs))
        }
    }

    /**
     * False while the WebView shows a page other than chat.deepseek.com (set by
     * the activity on every main-frame load). Storage, files, fetch/MCP and the
     * sandbox then refuse to serve it.
     */
    @Volatile var trustedPage: Boolean = true

    // ── Linux sandbox (built-in MCP server "sandbox") ────────────────────────

    private val sandboxExecutor = java.util.concurrent.Executors.newCachedThreadPool()
    private val sandbox by lazy { Sandbox.get(context) }

    /** Set by the activity: shows a URL served from inside the sandbox. */
    @Volatile var sandboxPreview: ((String) -> Boolean)? = null

    /** Set by the activity: opens Linux Studio. */
    @Volatile var onOpenStudio: (() -> Unit)? = null

    /** Native-only per-server key memory for MCP Apps viewers. Filled only when the
     * trusted chat page itself uses a server with its own key; generated content can
     * neither supply nor read keys. Cleared with process lifetime (fail closed). */
    private val mcpKeyCache = java.util.concurrent.ConcurrentHashMap<String, String>()

    /** Keystore-encrypted copy of MCP keys so MCP App viewers keep working after a restart. */
    private val credentialStore by lazy { SecureCredentialStore(context) }
    private val persistedKeys = java.util.concurrent.ConcurrentHashMap<String, Int>()

    private fun rememberMcpKey(serverUrl: String, apiKey: String) {
        mcpKeyCache[serverUrl] = apiKey
        val h = apiKey.hashCode()
        if (persistedKeys[serverUrl] == h) return
        persistedKeys[serverUrl] = h
        ioExecutor.execute { if (!credentialStore.put(serverUrl, apiKey)) persistedKeys.remove(serverUrl) }
    }

    /** Session key first, then the encrypted store. Never exposed to JavaScript. */
    internal fun mcpKeyFor(serverUrl: String): String =
        mcpKeyCache[serverUrl] ?: credentialStore.get(serverUrl)?.also { mcpKeyCache[serverUrl] = it } ?: ""

    /** resources/read on the existing MCP session. Resource URIs are strictly
     * validated; response text is size-capped; credentials never leave native code. */
    fun mcpReadResourceResult(serverUrl: String, resourceUri: String, apiKey: String): JSONObject {
        val out = JSONObject()
        if (normalizeHttpUrl(serverUrl) == null || !McpAppPolicy.validResourceUri(resourceUri)) {
            out.put("ok", false); out.put("error", "Invalid MCP server or resource URI"); return out
        }
        return try {
            val result = executeMcpJsonRpc(serverUrl, "resources/read", JSONObject().put("uri", resourceUri), apiKey)
            val contents = result.optJSONArray("contents") ?: result.optJSONObject("result")?.optJSONArray("contents")
            // Prefer the html entry when a server returns several contents.
            var first = contents?.optJSONObject(0)
            if (contents != null) for (i in 0 until minOf(contents.length(), 8)) {
                val c = contents.optJSONObject(i) ?: continue
                if (c.optString("mimeType").lowercase().contains("html")) { first = c; break }
            }
            var text = first?.optString("text") ?: ""
            if (text.isEmpty()) {
                // Spec allows BlobResourceContents (base64) for the same payload.
                val blob = first?.optString("blob") ?: ""
                if (blob.isNotEmpty() && blob.length <= (McpAppPolicy.MAX_RESOURCE_CHARS / 3) * 4 + 4) {
                    text = runCatching { String(android.util.Base64.decode(blob, android.util.Base64.DEFAULT), Charsets.UTF_8) }.getOrDefault("")
                }
            }
            val mime = (first?.optString("mimeType") ?: "").ifEmpty { "text/html" }
            when {
                text.isEmpty() -> { out.put("ok", false); out.put("error", "Resource has no text content") }
                text.length > McpAppPolicy.MAX_RESOURCE_CHARS -> { out.put("ok", false); out.put("error", "Resource too large (" + (text.length / 1024) + " KB)") }
                !McpAppPolicy.renderableMime(mime) -> { out.put("ok", false); out.put("error", "Unsupported resource type: " + mime.take(80)) }
                else -> {
                    out.put("ok", true); out.put("mimeType", mime); out.put("text", text)
                    first?.optJSONObject("_meta")?.let { out.put("meta", it) }
                }
            }
            out
        } catch (t: Throwable) {
            out.put("ok", false); out.put("error", (t.message ?: "resources/read failed").take(180)); out
        }
    }

    /** Credential presence for a configured MCP server. The secret itself never crosses the bridge. */
    @JavascriptInterface
    fun mcpCredentialStatus(serverUrl: String?): String {
        if (!trustedPage) return "{}"
        val server = serverUrl?.trim() ?: return "{}"
        if (!McpAppPolicy.validServerUrl(server)) return "{}"
        return JSONObject()
            .put("session", mcpKeyCache.containsKey(server))
            .put("stored", runCatching { credentialStore.has(server) }.getOrDefault(false))
            .toString()
    }

    @JavascriptInterface
    fun mcpCredentialForget(serverUrl: String?): Boolean {
        if (!trustedPage) return false
        val server = serverUrl?.trim() ?: return false
        if (!McpAppPolicy.validServerUrl(server)) return false
        mcpKeyCache.remove(server); persistedKeys.remove(server)
        mcpSessionCache.keys.filter { it.startsWith("$server|") }.forEach { mcpSessionCache.remove(it) }
        return runCatching { credentialStore.remove(server) }.getOrDefault(false)
    }

    /** Opens a generated HTML app in the bridge-free, offline [GeneratedAppActivity]. */
    @JavascriptInterface
    fun openGeneratedApp(html: String?): Boolean {
        if (!trustedPage) return false
        val doc = html ?: return false
        if (!GeneratedApps.acceptable(doc)) return false
        val activity = context as? android.app.Activity ?: return false
        return runCatching {
            val id = GeneratedApps.write(context.cacheDir, doc)
            Handler(Looper.getMainLooper()).post {
                if (activity.isFinishing || !trustedPage) return@post
                runCatching {
                    activity.startActivity(Intent(activity, GeneratedAppActivity::class.java).putExtra("artifact", id))
                }.onFailure { showToast("Could not open the app viewer") }
            }
            true
        }.getOrDefault(false)
    }

    /** Native share sheet for an exported artifact (already redacted by the page). */
    @JavascriptInterface
    fun shareFile(base64: String?, mimeType: String?, fileName: String?, title: String?): Boolean {
        if (!trustedPage) return false
        val payload = base64?.takeIf { it.isNotEmpty() && it.length <= GeneratedApps.MAX_SHARE_BASE64 } ?: return false
        val mime = mimeType?.trim()?.lowercase(Locale.ROOT)?.takeIf { it in GeneratedApps.SHARE_MIME } ?: return false
        val activity = context as? android.app.Activity ?: return false
        val name = sanitizeDownloadName(fileName)
        ioExecutor.execute {
            runCatching {
                val bytes = Base64.decode(payload, Base64.DEFAULT)
                val file = GeneratedApps.writeShare(context.cacheDir, name, bytes)
                val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = mime
                    putExtra(Intent.EXTRA_STREAM, uri)
                    putExtra(Intent.EXTRA_TITLE, (title ?: name).take(80))
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    clipData = android.content.ClipData.newRawUri(name, uri)
                }
                Handler(Looper.getMainLooper()).post {
                    runCatching { activity.startActivity(Intent.createChooser(send, (title ?: "Share").take(80))) }
                        .onFailure { showToast("No app available to share with") }
                }
            }.onFailure { Log.e(TAG, "shareFile failed", it); showToast("Share failed") }
        }
        return true
    }


    @JavascriptInterface
    fun openStudio() {
        if (!trustedPage) return
        onOpenStudio?.invoke()
    }

    private val sandboxTools by lazy { SandboxTools(sandbox) { url -> sandboxPreview?.invoke(url) ?: false } }

    private fun isSandboxPayload(payloadJson: String?): Boolean {
        if (payloadJson == null || !payloadJson.contains("sandbox")) return false
        return runCatching { SandboxTools.isSandboxUrl(JSONObject(payloadJson).optString("serverUrl")) }.getOrDefault(false)
    }

    fun isSandboxEnabled(): Boolean = prefs.getString(KEY_SANDBOX_ENABLED, "1") != "0"

    /** Sandbox state for the page: {supported, enabled, installed, mode, …}. Never throws. */
    @JavascriptInterface
    fun sandboxInfo(): String = if (!trustedPage) UNTRUSTED_SANDBOX_INFO else try {
        sandbox.status()
                .put("enabled", isSandboxEnabled())
                .put("mode", prefs.getString(KEY_SANDBOX_MODE, "auto") ?: "auto")
                .toString()
    } catch (t: Throwable) {
        JSONObject().put("supported", false).put("enabled", false).put("reason", t.message ?: "").toString()
    }

    /**
     * What the AI should know about its Linux right now (added to the tool
     * instructions): set up or not, approval mode, running background jobs and
     * the top of /root/workspace. Small and cheap: no process is started.
     */
    @JavascriptInterface
    fun sandboxContext(): String = if (!trustedPage) "{}" else try {
        val s = sandbox.status()
        val o = JSONObject()
                .put("supported", s.optBoolean("supported"))
                .put("installed", s.optBoolean("installed"))
                .put("enabled", isSandboxEnabled())
                .put("mode", prefs.getString(KEY_SANDBOX_MODE, "auto") ?: "auto")
        val jobs = JSONArray()
        sandbox.listJobs().filter { it.isRunning }.takeLast(6).forEach {
            jobs.put(JSONObject().put("id", it.id).put("command", it.command.replace('\n', ' ').take(120)))
        }
        o.put("jobs", jobs)
        val ws = if (s.optBoolean("installed")) sandbox.hostFile(Sandbox.WORKSPACE)?.takeIf { it.isDirectory } else null
        val kids = ws?.listFiles()?.filter { !it.name.startsWith(".") }?.sortedWith(compareBy({ !it.isDirectory }, { it.name.lowercase(Locale.ROOT) })) ?: emptyList()
        o.put("workspace", JSONArray(kids.take(20).map { it.name.take(60) + if (it.isDirectory) "/" else "" }))
        o.put("workspaceCount", kids.size)
        val free = s.optLong("freeBytes", -1)
        if (free >= 0) o.put("freeMb", free / (1024 * 1024))
        o.toString()
    } catch (t: Throwable) {
        "{}"
    }

    /** Settings → Linux & Agent → Reset: deletes the Linux system and its files (in the background). */
    @JavascriptInterface
    fun sandboxReset(): Boolean {
        if (!trustedPage) return false
        Thread({
            runCatching { sandbox.reset() }
            runCatching { evaluateJs?.invoke("window.__sdAgent&&window.__sdAgent.refresh&&window.__sdAgent.refresh('reset')") }
        }, "sandbox-reset").start()
        return true
    }

    /** Stop button: ends every sandbox command and background job. */
    @JavascriptInterface
    fun sandboxStop(): Int = if (!trustedPage) 0 else try {
        SandboxService.onAgentActiveChanged(context, false)
        sandbox.killAll()
    } catch (t: Throwable) { 0 }

    /** The page's agent loop started/finished: keeps the app protected for the whole task. */
    @JavascriptInterface
    fun sandboxAgentActive(active: Boolean) {
        if (!trustedPage) return
        runCatching { SandboxService.onAgentActiveChanged(context, active) }
    }

    private fun handleSandboxListTools(response: JSONObject) {
        when {
            !isSandboxEnabled() -> response.put("ok", false).put("error", "The Linux sandbox is turned off.")
            !sandbox.isSupported() -> response.put("ok", false).put("error", sandbox.unsupportedReason())
            else -> response.put("ok", true).put("tools", sandboxTools.listTools())
        }
    }

    private fun handleSandboxCall(toolName: String, args: JSONObject, response: JSONObject) {
        if (!isSandboxEnabled()) {
            response.put("ok", false).put("error", "The Linux sandbox is turned off in the app.")
            return
        }
        runCatching { onSandboxCallStarted?.invoke() }
        response.put("ok", true).put("result", sandboxTools.call(toolName, args))
    }

    /** Set by the activity: a sandbox tool call is starting (used to ask for notifications once). */
    @Volatile var onSandboxCallStarted: (() -> Unit)? = null

    /** The page has read a `/__sd/blob/<token>` path; drop it (frees image bytes early). */
    @JavascriptInterface
    fun releaseBlob(path: String?) {
        parseBlobToken(path)?.let { blobs.remove(it) }
    }

    /**
     * Single entry point for sendMessage-shaped payloads. The JS polyfill calls this with the
     * JSON-encoded message and parses the JSON response.
     *
     * Supported types: bds-fetch-url -> { ok, status, html } bds-fetch-github-zip -> { ok, base64,
     * status?, authRejected? } bds-fetch-github-commits -> { ok, commits, status?,
     * authRejected?, rateLimited? } bds-get-youtube-transcript -> { ok: false, error: "..." }
     *
     * Unknown types return { ok: false, error: "..." } so the JS side never sees an exception cross
     * the bridge.
     */
    @JavascriptInterface
    fun fetch(payloadJson: String?): String {
        if (!trustedPage) return UNTRUSTED_REPLY
        val response = JSONObject()
        try {
            val payload = JSONObject(payloadJson ?: "{}")
            when (val type = payload.optString("type")) {
                "bds-fetch-url" -> handleFetchUrl(payload, response)
                "bds-frame-fetch" -> handleFrameFetch(payload, response)
                "bds-fetch-github-zip" -> handleFetchGithubZip(payload, response)
                "bds-fetch-github-commits" -> handleFetchGithubCommits(payload, response)
                "bds-mcp-list-tools" -> handleMcpListTools(payload, response)
                "bds-mcp-call" -> handleMcpCallTool(payload, response)
                "bds-mcp-read-resource" -> handleMcpReadResource(payload, response)
                "bds-get-youtube-transcript" -> handleYoutubeTranscript(payload, response)
                else -> {
                    response.put("ok", false)
                    response.put("error", "Unsupported bridge message type: $type")
                }
            }
        } catch (t: Throwable) {
            response.put("ok", false)
            response.put("error", "Bridge error: ${t.message ?: t.javaClass.simpleName}")
        }
        return response.toString()
    }

    /** Client for visual/artifact fetches: SSRF-safe DNS, no cookie jar, no cache, short timeouts. */
    private val frameFetchClient: OkHttpClient by lazy {
        this.httpClient.newBuilder()
            .dns(FrameFetchPolicy.SafeDns())
            // Never through a proxy: a proxy resolves the target itself, so SafeDns would
            // only see the proxy's name (a local proxy/VPN app could then reach the LAN).
            .proxy(java.net.Proxy.NO_PROXY)
            .cookieJar(okhttp3.CookieJar.NO_COOKIES)
            .cache(null)
            // Every hop (redirects included) is re-checked: SafeDns never sees
            // IP literals, so a public page redirecting to http://127.0.0.1/
            // must be stopped here.
            .addNetworkInterceptor(FrameFetchPolicy.HopGuard)
            .followRedirects(true).followSslRedirects(true)
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(FrameFetchPolicy.TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .callTimeout(FrameFetchPolicy.TIMEOUT_MS + 5_000, TimeUnit.MILLISECONDS)
            .build()
    }

    /**
     * `sdFetch()` from a generated visual, after the user allowed the website in
     * the page. Returns { ok, status, url, contentType, text | base64, truncated }.
     */
    private fun handleFrameFetch(payload: JSONObject, response: JSONObject) {
        val url = payload.optString("url").trim().toHttpUrlOrNull()
        if (!FrameFetchPolicy.urlAllowed(url)) {
            response.put("ok", false); response.put("error", "This address is not allowed (only public http/https websites)."); return
        }
        val method = payload.optString("method", "GET").uppercase().ifEmpty { "GET" }
        if (method !in FrameFetchPolicy.METHODS) { response.put("ok", false); response.put("error", "Method not allowed: $method"); return }
        val builder = Request.Builder().url(url!!)
        payload.optJSONObject("headers")?.let { h ->
            val keys = h.keys(); var n = 0
            while (keys.hasNext() && n < 24) { val k = keys.next(); n++; if (FrameFetchPolicy.headerAllowed(k)) runCatching { builder.header(k, h.optString(k).take(2000)) } }
        }
        builder.header("User-Agent", DEFAULT_FETCH_USER_AGENT)
        val contentType = payload.optJSONObject("headers")?.let { h ->
            h.keys().asSequence().firstOrNull { it.equals("Content-Type", ignoreCase = true) }?.let { h.optString(it) }
        }?.takeIf { it.isNotEmpty() } ?: "application/json"
        val body = payload.optString("body", "")
        if (body.length > FrameFetchPolicy.MAX_REQUEST_BODY_CHARS) { response.put("ok", false); response.put("error", "Request body too large"); return }
        when (method) {
            "GET" -> builder.get()
            "HEAD" -> builder.head()
            else -> builder.post(body.toRequestBody(contentType.toMediaTypeOrNull()))
        }
        try {
            frameFetchClient.newCall(builder.build()).execute().use { resp ->
                response.put("ok", resp.isSuccessful)
                response.put("status", resp.code)
                response.put("url", resp.request.url.toString())
                val ct = resp.header("Content-Type") ?: ""
                response.put("contentType", ct)
                if (!resp.isSuccessful) response.put("error", "Server returned ${resp.code}")
                if (method == "HEAD") return
                val bounded = resp.body?.byteStream()?.use { readBoundedBytes(it, FrameFetchPolicy.MAX_RESPONSE_BYTES) }
                if (bounded?.overflowed == true) response.put("truncated", true)
                val bytes = bounded?.bytes ?: ByteArray(0)
                if (FrameFetchPolicy.isTextual(ct)) {
                    val cs = detectCharsetFromHeaders(resp) ?: "UTF-8"
                    response.put("text", runCatching { String(bytes, Charset.forName(cs)) }.getOrElse { String(bytes, Charsets.UTF_8) })
                } else {
                    response.put("base64", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
                }
            }
        } catch (e: java.io.IOException) {
            response.put("ok", false)
            response.put("error", if (e is java.net.UnknownHostException && e.message?.contains("Blocked") == true) e.message else "Network error: ${e.message ?: e.javaClass.simpleName}")
        }
    }

    private fun handleFetchUrl(payload: JSONObject, response: JSONObject) {
        val rawUrl = payload.optString("url")
        if (rawUrl.isEmpty()) {
            response.put("ok", false)
            response.put("error", "No URL provided.")
            return
        }

        val url = normalizeHttpUrl(rawUrl)
        if (url == null) {
            response.put("ok", false)
            response.put("error", "Expected an http or https URL.")
            return
        }
        val parsedUrl = url.toHttpUrlOrNull()
        if (!FrameFetchPolicy.urlAllowed(parsedUrl, allowLoopback = allowLoopbackFetchUrl)) {
            response.put("ok", false)
            response.put("error", "This address is not allowed (only public http/https websites).")
            return
        }

        val options = payload.optJSONObject("options")
        val method = options?.optString("method")?.uppercase()?.ifEmpty { "GET" } ?: "GET"
        if (method !in FrameFetchPolicy.METHODS) {
            response.put("ok", false)
            response.put("error", "Method not allowed: $method")
            return
        }
        val headersJson = options?.optJSONObject("headers")
        val body = options?.optString("body")?.takeIf { it.isNotEmpty() }
        if (body != null && body.length > FrameFetchPolicy.MAX_REQUEST_BODY_CHARS) {
            response.put("ok", false)
            response.put("error", "Request body too large")
            return
        }

        val builder = Request.Builder().url(parsedUrl!!)
        if (headersJson != null) {
            val keys = headersJson.keys()
            var n = 0
            while (keys.hasNext() && n < 24) {
                val k = keys.next()
                n++
                if (FrameFetchPolicy.headerAllowed(k)) {
                    runCatching { builder.header(k, headersJson.optString(k).take(2000)) }
                }
            }
        }
        // Present a browser fingerprint: a bare OkHttp client sends "okhttp/<version>",
        // which search engines challenge or serve irrelevant results to (especially for
        // non-Latin queries). An explicit User-Agent in the payload wins over the default.
        val explicitUserAgent = headersJson?.keys()?.asSequence()
                ?.firstOrNull { it.equals("User-Agent", ignoreCase = true) }
                ?.let { headersJson.optString(it) }
                ?.takeIf { it.isNotBlank() }
        builder.header("User-Agent", (explicitUserAgent ?: DEFAULT_FETCH_USER_AGENT).take(512))
        when (method) {
            "GET" -> builder.get()
            "HEAD" -> builder.head()
            else -> {
                val mediaType =
                        headersJson
                                ?.keys()?.asSequence()
                                ?.firstOrNull { it.equals("Content-Type", ignoreCase = true) }
                                ?.let { headersJson.optString(it) }
                                ?.takeIf { it.isNotEmpty() }
                                ?.toMediaTypeOrNull()
                                ?: "application/json".toMediaTypeOrNull()
                builder.post((body ?: "").toRequestBody(mediaType))
            }
        }

        // Optional per-call budget mirroring the desktop service worker: a
        // hanging provider must fail fast so the JS chain can move on to the
        // next one (#148). Without this the shared client's 120s callTimeout
        // would apply, blocking the bridged JS call for up to two minutes.
        val callTimeoutMs = options?.optLong("timeoutMs", 0L)?.takeIf { it > 0L }
        val client = if (callTimeoutMs != null) {
            publicFetchClient.newBuilder()
                    .callTimeout(callTimeoutMs, TimeUnit.MILLISECONDS)
                    .build()
        } else {
            publicFetchClient
        }

        try {
            client.newCall(builder.build()).execute().use { resp ->
                response.put("status", resp.code)
                if (!resp.isSuccessful) {
                    response.put("ok", false)
                    response.put("error", "Server returned ${resp.code} for $url")
                    return
                }
                response.put("ok", true)
                // Bounded: a link to a huge file must not take the app down (OOM).
                val bounded = resp.body?.byteStream()?.use { readBoundedBytes(it, MAX_FETCH_BODY_BYTES) }
                if (bounded?.overflowed == true) response.put("truncated", true)
                val bytes = bounded?.bytes
                if (bytes != null) {
                    val charset = detectCharsetFromHeaders(resp) ?: detectCharsetFromHtml(bytes)
                    val html = try {
                        String(bytes, Charset.forName(charset ?: "UTF-8"))
                    } catch (_: Exception) {
                        String(bytes, Charset.forName("UTF-8"))
                    }
                    response.put("html", html)
                } else {
                    response.put("html", "")
                }
            }
        } catch (e: java.io.IOException) {
            response.put("ok", false)
            response.put(
                    "error",
                    if (callTimeoutMs != null && e is java.net.SocketTimeoutException) {
                        "Request timed out after ${callTimeoutMs}ms"
                    } else {
                        "Network error: ${e.message ?: e.javaClass.simpleName}"
                    }
            )
        }
    }

    private fun normalizeHttpUrl(rawUrl: String): String? {
        val input = rawUrl.trim()
        if (input.isEmpty()) return null

        val markdownUrl =
                Regex("""\[[^\]]*]\(\s*(https?://[^\)\s]+)""", RegexOption.IGNORE_CASE)
                        .find(input)
                        ?.groupValues
                        ?.getOrNull(1)
        val inlineUrl =
                Regex("""https?://[^\s<>"'\)\]]+""", RegexOption.IGNORE_CASE)
                        .find(input)
                        ?.value
        val candidate =
                (markdownUrl ?: inlineUrl ?: input)
                        .trim()
                        .trim('`', '"', '\'')
                        .removeSurrounding("<", ">")
                        .replace("&amp;", "&")
                        .replace(Regex("[.,;:]+$"), "")

        return candidate.toHttpUrlOrNull()?.toString()
    }

    private fun detectCharsetFromHeaders(resp: okhttp3.Response): String? {
        val contentType = resp.header("Content-Type") ?: return null
        val regex = Regex("""charset\s*=\s*([^\s;]+)""", RegexOption.IGNORE_CASE)
        return regex.find(contentType)
            ?.groupValues
            ?.get(1)
            ?.trim()
            ?.removeSurrounding("\"")
            ?.removeSurrounding("'")
    }

    private fun detectCharsetFromHtml(bytes: ByteArray): String? {
        val scanSize = minOf(bytes.size, 10240)
        val scanBytes = bytes.copyOfRange(0, scanSize)
        val scanView = scanBytes.toString(Charset.forName("ISO-8859-1"))

        val metaCharset = Regex(
            """<meta[\s>][^>]*charset\s*=\s*["']?\s*([a-zA-Z0-9_-]+)\s*["']?[^>]*\/?>""",
            RegexOption.IGNORE_CASE
        ).find(scanView)
        if (metaCharset != null) return metaCharset.groupValues[1]

        val httpEquiv = Regex(
            """<meta\s+http-equiv\s*=\s*["']?\s*Content-Type\s*["']?\s*content\s*=\s*["'][^"']*charset\s*=\s*([a-zA-Z0-9_-]+)""",
            RegexOption.IGNORE_CASE
        ).find(scanView)
        if (httpEquiv != null) return httpEquiv.groupValues[1]

        return null
    }

    private fun handleFetchGithubZip(payload: JSONObject, response: JSONObject) {
        val url = payload.optString("url")
        if (url.isEmpty()) {
            response.put("ok", false)
            response.put("error", "No URL provided.")
            return
        }
        val token = payload.optString("token").trim()
        val canSendToken = token.isNotEmpty() && isCodeloadHost(url)

        if (canSendToken) {
            val authResponse =
                    runCatching {
                                httpClient
                                        .newCall(
                                                Request.Builder()
                                                        .url(url)
                                                        .header("Authorization", "token $token")
                                                        .build()
                                        )
                                        .execute()
                            }
                            .getOrNull()

            if (authResponse != null) {
                authResponse.use { resp ->
                    if (resp.isSuccessful) {
                        encodeZipToResponse(resp, url, response)
                        return
                    }
                    if (resp.code == 401 || resp.code == 403) {
                        response.put("ok", false)
                        response.put("status", resp.code)
                        response.put("authRejected", true)
                        response.put("error", "GitHub rejected the supplied token for $url")
                        return
                    }
                }
            }
        }

        httpClient.newCall(Request.Builder().url(url).build()).execute().use { resp ->
            if (!resp.isSuccessful) {
                response.put("ok", false)
                response.put("status", resp.code)
                response.put("error", "GitHub returned ${resp.code} for $url")
                return
            }
            encodeZipToResponse(resp, url, response)
        }
    }

    private fun handleFetchGithubCommits(payload: JSONObject, response: JSONObject) {
        val owner = payload.optString("owner").trim()
        val repo = payload.optString("repo").trim()
        val branch = payload.optString("branch").trim().ifEmpty { "main" }
        val token = payload.optString("token").trim()
        val count = normalizeGithubCommitCount(payload.opt("count"))

        if (owner.isEmpty() || repo.isEmpty()) {
            response.put("ok", false)
            response.put("error", "Missing GitHub repository.")
            return
        }
        // Names go into the API path verbatim: GitHub allows only these characters.
        val validName = Regex("^[A-Za-z0-9._-]{1,100}$")
        if (!validName.matches(owner) || !validName.matches(repo)) {
            response.put("ok", false)
            response.put("error", "Invalid GitHub repository name: $owner/$repo")
            return
        }

        val commits = JSONArray()
        var page = 1

        // GitHub's commits API only returns up to 100 items per page, so
        // larger UI counts must be assembled across multiple requests.
        while (commits.length() < count) {
            val remaining = count - commits.length()
            val perPage = minOf(GITHUB_COMMITS_PAGE_SIZE, remaining)
            var fetchedThisPage: Int
            val requestBuilder =
                    Request.Builder()
                            .url(buildGithubCommitsUrl(owner, repo, branch, perPage, page))
                            .header("Accept", "application/vnd.github+json")

            if (token.isNotEmpty()) {
                requestBuilder.header("Authorization", "token $token")
            }

            httpClient.newCall(requestBuilder.build()).execute().use { resp ->
                val bodyText = resp.body?.string() ?: ""

                if (!resp.isSuccessful) {
                    if (isGithubRateLimitResponse(resp.code, resp.header("X-RateLimit-Remaining"), bodyText)) {
                        putGithubError(
                                response,
                                "GitHub API rate limit hit. Add a token for more requests.",
                                resp.code,
                                rateLimited = true,
                        )
                        return
                    }

                    if (token.isNotEmpty() && (resp.code == 401 || resp.code == 403)) {
                        putGithubError(
                                response,
                                "GitHub rejected the supplied token for $owner/$repo",
                                resp.code,
                                authRejected = true,
                        )
                        return
                    }

                    if (resp.code == 404) {
                        putGithubError(
                                response,
                                "Repository not found or you may need a GitHub token for private repos. Add one in Advanced Settings.",
                                resp.code,
                        )
                        return
                    }

                    putGithubError(
                            response,
                            "GitHub returned ${resp.code} ${resp.message}".trim(),
                            resp.code,
                    )
                    return
                }

                val pageCommits =
                        try {
                            JSONArray(bodyText)
                        } catch (t: Throwable) {
                            response.put("ok", false)
                            response.put("error", "Unexpected GitHub commits response.")
                            return
                        }

                for (i in 0 until pageCommits.length()) {
                    if (commits.length() >= count) break
                    commits.put(normalizeGithubCommit(pageCommits.getJSONObject(i)))
                }
                fetchedThisPage = pageCommits.length()
            }

            if (fetchedThisPage < perPage) break
            page += 1
        }

        response.put("ok", true)
        response.put("commits", commits)
    }

    private fun encodeZipToResponse(resp: okhttp3.Response, url: String, response: JSONObject) {
        val bounded = resp.body?.byteStream()?.use { readBoundedBytes(it, MAX_ZIP_BYTES) }
        if (bounded?.overflowed == true) {
            response.put("ok", false)
            response.put("status", resp.code)
            response.put("error", "Repository archive is larger than ${MAX_ZIP_BYTES / (1024 * 1024)} MB: $url")
            return
        }
        val bytes = bounded?.bytes ?: ByteArray(0)
        if (bytes.size < 100) {
            response.put("ok", false)
            response.put("error", "Received empty or invalid ZIP from $url")
            return
        }
        response.put("ok", true)
        response.put("status", resp.code)
        response.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
    }

    private fun isCodeloadHost(url: String): Boolean =
            try {
                java.net.URI(url).host == "codeload.github.com"
            } catch (t: Throwable) {
                false
            }

    private fun normalizeGithubCommitCount(rawCount: Any?): Int {
        val parsed =
                when (rawCount) {
                    is Number -> rawCount.toInt()
                    is String -> rawCount.toIntOrNull()
                    else -> null
                } ?: DEFAULT_GITHUB_COMMIT_COUNT
        // Each 100 commits is one API request; an absurd count must not loop for minutes.
        return parsed.coerceIn(1, MAX_GITHUB_COMMIT_COUNT)
    }

    private fun buildGithubCommitsUrl(
            owner: String,
            repo: String,
            branch: String,
            perPage: Int,
            page: Int,
    ): String {
        val encodedBranch = Uri.encode(branch)
        return "$githubApiBaseUrl/repos/$owner/$repo/commits?sha=$encodedBranch&per_page=$perPage&page=$page"
    }

    private fun isGithubRateLimitResponse(
            statusCode: Int,
            remainingHeader: String?,
            bodyText: String,
    ): Boolean {
        val remaining = remainingHeader?.toIntOrNull()
        return (statusCode == 403 || statusCode == 429) &&
                (remaining == 0 || bodyText.contains("API rate limit exceeded", ignoreCase = true))
    }

    private fun normalizeGithubCommit(commit: JSONObject): JSONObject {
        val commitData = commit.optJSONObject("commit") ?: JSONObject()
        val authorData =
                commitData.optJSONObject("author")
                        ?: commitData.optJSONObject("committer")
                        ?: JSONObject()
        val sha = commit.optString("sha").trim()
        val author = authorData.optString("name").trim().ifEmpty { "Unknown author" }
        val date = authorData.optString("date").trim().ifEmpty { "unknown date" }
        val message = commitData.optString("message").trim().ifEmpty { "(no message)" }

        return JSONObject().apply {
            put("sha", if (sha.isNotEmpty()) sha.take(7) else "unknown")
            put("author", author)
            put("date", date)
            put("message", message)
        }
    }

    private fun putGithubError(
            response: JSONObject,
            message: String,
            status: Int? = null,
            authRejected: Boolean = false,
            rateLimited: Boolean = false,
    ) {
        response.put("ok", false)
        response.put("error", message)
        if (status != null) {
            response.put("status", status)
        }
        if (authRejected) {
            response.put("authRejected", true)
        }
        if (rateLimited) {
            response.put("rateLimited", true)
        }
    }

    // ── MCP (Model Context Protocol) Implementation ──────────────────────────

    private data class McpSession(val sessionId: String?, val authMethod: String)
    private val mcpSessionCache = java.util.concurrent.ConcurrentHashMap<String, McpSession>()
    private val mcpReqId = java.util.concurrent.atomic.AtomicInteger(100)

    /** Servers the trusted page itself has used (its own MCP settings). MCP Apps
     * resources are only read from these, never from a URL a model wrote. The set is
     * persisted (URLs only, no keys) so an MCP app in an old chat still opens after the
     * app was restarted, before the page has listed that server's tools again. */
    private val knownMcpServers: MutableSet<String> =
            java.util.concurrent.ConcurrentHashMap.newKeySet<String>().apply {
                runCatching { prefs.getStringSet(KEY_KNOWN_MCP_SERVERS, null)?.let { addAll(it) } }
            }

    private fun markMcpServerKnown(serverUrl: String) {
        if (SandboxTools.isSandboxUrl(serverUrl)) return
        if (!serverUrl.startsWith("https://") && !serverUrl.startsWith("http://")) return
        if (!knownMcpServers.add(serverUrl)) return
        runCatching {
            prefs.edit().putStringSet(KEY_KNOWN_MCP_SERVERS, HashSet(knownMcpServers.take(MAX_KNOWN_MCP_SERVERS))).apply()
        }
    }

    /** The page's explicit key, else the key remembered natively for this exact server. */
    private fun mcpKeyFrom(payload: JSONObject, serverUrl: String): String =
        payload.optString("apiKey").trim().ifEmpty { if (SandboxTools.isSandboxUrl(serverUrl)) "" else runCatching { mcpKeyFor(serverUrl) }.getOrDefault("") }

    private fun handleMcpListTools(payload: JSONObject, response: JSONObject) {
        val serverUrl = payload.optString("serverUrl").trim()

        if (serverUrl.isEmpty()) {
            response.put("ok", false)
            response.put("error", "No MCP server URL provided.")
            return
        }
        val apiKey = mcpKeyFrom(payload, serverUrl)
        markMcpServerKnown(serverUrl)
        if (apiKey.isNotEmpty()) rememberMcpKey(serverUrl, apiKey)
        if (SandboxTools.isSandboxUrl(serverUrl)) {
            handleSandboxListTools(response)
            return
        }

        try {
            val result = executeMcpJsonRpc(serverUrl, "tools/list", JSONObject(), apiKey)
            val toolsArray = when {
                result.has("tools") -> result.optJSONArray("tools") ?: JSONArray()
                else -> JSONArray()
            }
            response.put("ok", true)
            response.put("tools", toolsArray)
        } catch (t: Throwable) {
            Log.e(TAG, "MCP list tools failed for $serverUrl", t)
            response.put("ok", false)
            response.put("error", t.message ?: "Failed to list MCP tools")
        }
    }

    private fun handleMcpCallTool(payload: JSONObject, response: JSONObject) {
        val serverUrl = payload.optString("serverUrl").trim()
        val toolName = payload.optString("toolName").trim()
        val args = payload.optJSONObject("args") ?: JSONObject()

        if (serverUrl.isEmpty() || toolName.isEmpty()) {
            response.put("ok", false)
            response.put("error", "Missing MCP server URL or tool name.")
            return
        }
        val apiKey = mcpKeyFrom(payload, serverUrl)
        if (apiKey.isNotEmpty()) rememberMcpKey(serverUrl, apiKey)
        if (SandboxTools.isSandboxUrl(serverUrl)) {
            handleSandboxCall(toolName, args, response)
            return
        }

        try {
            val params = JSONObject().apply {
                put("name", toolName)
                put("arguments", args)
            }
            val result = executeMcpJsonRpc(serverUrl, "tools/call", params, apiKey)
            response.put("ok", true)
            response.put("result", result)
        } catch (t: Throwable) {
            Log.e(TAG, "MCP tool call failed: $toolName on $serverUrl", t)
            response.put("ok", false)
            response.put("error", t.message ?: "MCP tool call failed")
        }
    }

    /** MCP Apps: resources/read for a ui:// resource of a server the page already uses. */
    private fun handleMcpReadResource(payload: JSONObject, response: JSONObject) {
        val serverUrl = payload.optString("serverUrl").trim()
        val uri = payload.optString("resourceUri").trim()
        if (serverUrl.isEmpty() || SandboxTools.isSandboxUrl(serverUrl) || serverUrl !in knownMcpServers) {
            response.put("ok", false)
            response.put("error", "Unknown MCP server: add it in MCP settings and use it once in chat.")
            return
        }
        val read = mcpReadResourceResult(serverUrl, uri, mcpKeyFrom(payload, serverUrl))
        val keys = read.keys()
        while (keys.hasNext()) { val k = keys.next(); response.put(k, read.get(k)) }
    }

    private fun executeMcpJsonRpc(
            serverUrl: String,
            method: String,
            params: JSONObject,
            apiKey: String,
            retryOnExpiry: Boolean = true
    ): JSONObject {
        val session = mcpEnsureInitialized(serverUrl, apiKey)
        val id = mcpReqId.incrementAndGet()
        val reqBody = JSONObject().apply {
            put("jsonrpc", "2.0")
            put("id", id)
            put("method", method)
            put("params", params)
        }

        return try {
            val fetchResult = mcpFetch(serverUrl, reqBody, apiKey, session.sessionId, session.authMethod)
            fetchResult.result
        } catch (t: McpSessionExpiredException) {
            if (retryOnExpiry) {
                mcpSessionCache.remove("$serverUrl|$apiKey")
                executeMcpJsonRpc(serverUrl, method, params, apiKey, retryOnExpiry = false)
            } else {
                throw t
            }
        }
    }

    private class McpSessionExpiredException(message: String) : Exception(message)

    private class McpServerError(message: String) : Exception(message)

    private fun mcpEnsureInitialized(serverUrl: String, apiKey: String): McpSession {
        val cacheKey = "$serverUrl|$apiKey"
        mcpSessionCache[cacheKey]?.let { return it }

        val initBody = JSONObject().apply {
            put("jsonrpc", "2.0")
            put("id", 1)
            put("method", "initialize")
            put("params", JSONObject().apply {
                put("protocolVersion", "2024-11-05")
                // MCP Apps (2026-01-26): advertise the UI extension so servers expose app tools.
                put("capabilities", JSONObject().put("extensions", JSONObject().put(
                    "io.modelcontextprotocol/ui", JSONObject().put("mimeTypes", JSONArray().put("text/html;profile=mcp-app")))))
                put("clientInfo", JSONObject().apply {
                    put("name", "super-deepseek-android")
                    put("version", "1.0.0")
                })
            })
        }

        val authMethods = if (apiKey.isNotEmpty()) {
            listOf("bearer", "x-api-key", "none")
        } else {
            listOf("none")
        }

        var lastError: Throwable? = null
        for (authMethod in authMethods) {
            try {
                val fetchResult = mcpFetch(serverUrl, initBody, apiKey, sessionId = null, authMethod = authMethod)
                val session = McpSession(fetchResult.sessionId, authMethod)
                mcpSessionCache[cacheKey] = session

                // Send notifications/initialized (best effort notification)
                try {
                    val notifyBody = JSONObject().apply {
                        put("jsonrpc", "2.0")
                        put("method", "notifications/initialized")
                    }
                    mcpFetch(serverUrl, notifyBody, apiKey, sessionId = session.sessionId, authMethod = authMethod)
                } catch (_: Throwable) {}

                return session
            } catch (t: Throwable) {
                val msg = t.message.orEmpty()
                if (msg.contains("401") || msg.contains("403")) {
                    lastError = t
                    continue
                }
                throw t
            }
        }

        throw lastError ?: Exception("Failed to initialize MCP connection to $serverUrl")
    }

    private data class McpFetchResult(val result: JSONObject, val sessionId: String?)

    private fun mcpFetch(
            serverUrl: String,
            body: JSONObject,
            apiKey: String,
            sessionId: String?,
            authMethod: String,
            timeoutSeconds: Long = 30L
    ): McpFetchResult {
        val httpUrl = normalizeHttpUrl(serverUrl) ?: throw IllegalArgumentException("Invalid MCP URL: $serverUrl")

        val builder = Request.Builder()
                .url(httpUrl)
                .header("Content-Type", "application/json")
                .header("Accept", "application/json, text/event-stream")
                .header("User-Agent", DEFAULT_FETCH_USER_AGENT)

        if (apiKey.isNotEmpty()) {
            when (authMethod) {
                "bearer" -> builder.header("Authorization", "Bearer $apiKey")
                "x-api-key" -> builder.header("X-API-Key", apiKey)
            }
        }
        if (!sessionId.isNullOrEmpty()) {
            builder.header("Mcp-Session-Id", sessionId)
        }

        val requestBody = body.toString().toRequestBody("application/json; charset=utf-8".toMediaTypeOrNull())
        builder.post(requestBody)

        val client = httpClient.newBuilder()
                .connectTimeout(minOf(15L, timeoutSeconds), TimeUnit.SECONDS)
                .readTimeout(timeoutSeconds, TimeUnit.SECONDS)
                .build()

        client.newCall(builder.build()).execute().use { resp ->
            val code = resp.code
            val responseSessionId = resp.header("Mcp-Session-Id")
            val contentType = resp.header("Content-Type", "")?.lowercase() ?: ""
            val sse = resp.isSuccessful && contentType.contains("text/event-stream")
            val bodyString = if (sse) "" else resp.body?.charStream()?.use { McpSse.readBounded(it, McpSse.MAX_RESPONSE_CHARS) }.orEmpty()

            // 400/404 only mean "session expired" when a session was sent; on a
            // fresh request they are real errors (wrong URL, bad request) and
            // re-initialising would just repeat them with a misleading message.
            if ((code == 400 || code == 404) && !sessionId.isNullOrEmpty()) {
                throw McpSessionExpiredException("MCP session expired or invalid (HTTP $code)")
            }
            if (!resp.isSuccessful) {
                throw Exception("MCP server returned HTTP $code: ${bodyString.take(200)}")
            }

            val resultJson: JSONObject = if (sse) {
                val msg = resp.body?.charStream()?.buffered()?.use { McpSse.readResponse(it, body.opt("id"), McpSse.MAX_RESPONSE_CHARS) }
                    ?: throw McpServerError("MCP server did not return a matching JSON-RPC response")
                if (msg.has("error")) {
                    val errObj = msg.optJSONObject("error")
                    val errMsg = errObj?.optString("message") ?: msg.optString("error")
                    throw McpServerError("MCP error: $errMsg")
                }
                when (val resVal = msg.opt("result")) {
                    null -> JSONObject()
                    is JSONObject -> resVal
                    else -> JSONObject().put("value", resVal)
                }
            } else {
                if (bodyString.isNotBlank()) {
                    val wantId = body.opt("id")
                    val parsed = McpSse.parseJsonRpcPayload(bodyString, wantId, strictSingleId = false)
                        ?: if (wantId != null) throw McpServerError("MCP server did not return a matching JSON-RPC response") else JSONObject()
                    if (parsed.has("error")) {
                        val errObj = parsed.optJSONObject("error")
                        val errMsg = errObj?.optString("message") ?: parsed.optString("error")
                        throw McpServerError("MCP error: $errMsg")
                    }
                    when (val resVal = parsed.opt("result")) {
                        null, JSONObject.NULL -> JSONObject()
                        is JSONObject -> resVal
                        is JSONArray -> JSONObject().put("tools", resVal)
                        else -> JSONObject().put("value", resVal)
                    }
                } else {
                    JSONObject()
                }
            }

            return McpFetchResult(resultJson, responseSessionId)
        }
    }

    // ── YouTube Transcript Implementation ────────────────────────────────────

    private fun handleYoutubeTranscript(payload: JSONObject, response: JSONObject) {
        val videoId = payload.optString("videoId").trim()
        if (videoId.isEmpty()) {
            response.put("ok", false)
            response.put("error", "No YouTube videoId provided.")
            return
        }

        try {
            val transcriptArray = fetchYoutubeTranscriptInternal(videoId)
            response.put("ok", true)
            response.put("transcript", transcriptArray)
        } catch (t: Throwable) {
            Log.w(TAG, "YouTube transcript fetch failed for $videoId", t)
            response.put("ok", false)
            response.put("error", t.message ?: "Failed to fetch YouTube transcript")
        }
    }

    private fun fetchYoutubeTranscriptInternal(videoId: String): JSONArray {
        val videoUrl = "https://www.youtube.com/watch?v=$videoId"
        val request = Request.Builder()
                .url(videoUrl)
                .header("User-Agent", DEFAULT_FETCH_USER_AGENT)
                .header("Accept-Language", "en-US,en;q=0.9")
                .get()
                .build()

        val html = httpClient.newCall(request).execute().use { resp ->
            if (!resp.isSuccessful) throw Exception("YouTube returned HTTP ${resp.code}")
            resp.body?.string().orEmpty()
        }

        val captionTracksRegex = Regex(""""captionTracks":\s*(\[.*?\])""")
        val match = captionTracksRegex.find(html)
                ?: throw Exception("No captions found for this YouTube video.")

        val tracksJson = JSONArray(match.groupValues[1])
        if (tracksJson.length() == 0) {
            throw Exception("Captions list is empty.")
        }

        var selectedUrl: String? = null
        for (i in 0 until tracksJson.length()) {
            val track = tracksJson.getJSONObject(i)
            val lang = track.optString("languageCode")
            val url = track.optString("baseUrl")
            if (url.isNotEmpty()) {
                if (lang.startsWith("en") || selectedUrl == null) {
                    selectedUrl = url
                }
            }
        }

        val captionUrl = selectedUrl ?: throw Exception("No caption track URL available.")
        val captionRequest = Request.Builder()
                .url(captionUrl)
                .header("User-Agent", DEFAULT_FETCH_USER_AGENT)
                .get()
                .build()

        val xmlString = httpClient.newCall(captionRequest).execute().use { resp ->
            resp.body?.string().orEmpty()
        }

        val transcriptArray = JSONArray()
        val textNodeRegex = Regex("""<text start="([\d.]+)"(?: dur="([\d.]+)")?>([\s\S]*?)</text>""")
        val textMatches = textNodeRegex.findAll(xmlString)

        for (m in textMatches) {
            val startSec = m.groupValues[1].toDoubleOrNull() ?: 0.0
            val durSec = m.groupValues.getOrNull(2)?.takeIf { it.isNotEmpty() }?.toDoubleOrNull() ?: 0.0
            val rawText = m.groupValues[3]
                    .replace("&amp;", "&")
                    .replace("&quot;", "\"")
                    .replace("&#39;", "'")
                    .replace("&lt;", "<")
                    .replace("&gt;", ">")
                    .replace("\n", " ")
                    .trim()

            if (rawText.isNotEmpty()) {
                val item = JSONObject().apply {
                    put("text", rawText)
                    put("offset", (startSec * 1000).toLong())
                    put("duration", (durSec * 1000).toLong())
                }
                transcriptArray.put(item)
            }
        }

        return transcriptArray
    }

    /**
     * Fired by the injected engine bundle once its UI polish pass has run —
     * the definitive "engine UI is up" signal for the boot overlay.
     */
    @JavascriptInterface
    fun onUiPolished() {
        onUiPolishedCallback?.invoke()
    }

    /** Removes the session token a legacy build kept in plain prefs (native call, not for JS). */
    fun removeLegacyToken() {
        engineStore.remove(LEGACY_TOKEN_KEY)
        prefs.edit().remove(LEGACY_TOKEN_KEY).apply()
    }

    // Sign-in and chat traffic are the official page's own: the engine runs
    // inside chat.deepseek.com, so no login or chat calls go through this bridge.
    // See docs/ARCHITECTURE.md.
    companion object {

        private const val TAG = "BdsWebViewBridge"
        // Shared with UpdateChecker, which keeps the update channel and the dismissed-build
        // digest alongside the JS storage keys.
        internal const val PREFS_NAME = "bds_storage"
        internal const val KEY_KNOWN_MCP_SERVERS = "sd_known_mcp_servers_v1"
        private const val MAX_KNOWN_MCP_SERVERS = 64
        private const val UNTRUSTED_REPLY = "{\"ok\":false,\"error\":\"Not available on this page.\"}"
        private const val LEGACY_TOKEN_KEY = "ds_official_token"
        private const val UNTRUSTED_SANDBOX_INFO = "{\"supported\":false,\"enabled\":false}"
        /** "0" turns the Linux sandbox off (default on). Shared with the page via get/setStorage. */
        internal const val KEY_SANDBOX_ENABLED = "sd_sandbox_enabled"
        /** "auto" runs the agent's sandbox commands directly; "ask" confirms each one. */
        internal const val KEY_SANDBOX_MODE = "sd_sandbox_mode"
        /** "0": no automatic "continue" when a reply stops mid-task (sd-agent.js). */
        internal const val KEY_AGENT_CONTINUE = "sd_agent_autocontinue"
        /** The chat's UI language ("bn", "en", …), written by sd-agent.js; Studio follows it. */
        internal const val KEY_UI_LOCALE = "sd_ui_locale"
        private const val DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com"
        private const val DEFAULT_GITHUB_COMMIT_COUNT = 100
        // Desktop Chrome UA for bds-fetch-url requests. Without it OkHttp sends
        // "okhttp/<version>", which search engines treat as a bot: DDG responds
        // with an anti-bot challenge (202) and Bing mishandles non-Latin queries
        // (returns irrelevant results). This mirrors what the web extension
        // effectively sends via Chrome's network stack.
        private const val DEFAULT_FETCH_USER_AGENT =
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
        private const val GITHUB_COMMITS_PAGE_SIZE = 100
        // Must match STORAGE_KEYS.pageIsDark in src/lib/constants.js — the Android chrome.storage
        // polyfill routes chrome.storage.local.set({ bds_page_is_dark: ... }) through setStorage,
        // so getLastKnownIsDark() and the polyfill share the same SharedPreferences key.
        internal const val KEY_LAST_PAGE_DARK = "bds_page_is_dark"

        /** Max bytes per native-picked text file or document. */
        internal const val MAX_PICKED_FILE_SIZE = 50L * 1024 * 1024

        /** Max bytes per native-picked image file. */
        internal const val MAX_PICKED_IMAGE_SIZE = 25L * 1024 * 1024

        /**
         * Max bytes per streamed binary file (documents, archives, media…):
         * DeepSeek's own per-file upload limit. Streamed, so never held in memory.
         */
        internal const val MAX_PICKED_BLOB_SIZE = 100L * 1024 * 1024

        /** Picked files read concurrently (see readPickedContentUris). */
        internal const val PICK_READ_PARALLELISM = 3

        /** Page/API bodies returned by bds-fetch-url are cut here (flagged truncated). */
        internal const val MAX_FETCH_BODY_BYTES = 16L * 1024 * 1024

        /** GitHub repository archives (bds-fetch-github-zip). */
        internal const val MAX_ZIP_BYTES = 64L * 1024 * 1024

        internal const val MAX_GITHUB_COMMIT_COUNT = 1000

        /** How much of a file is sampled to tell text from binary. */
        internal const val TEXT_SNIFF_BYTES = 64 * 1024

        /** Folder files with an unknown extension are only sniffed up to this size. */
        internal const val MAX_UNKNOWN_FOLDER_FILE_SIZE = 2L * 1024 * 1024

        internal const val MAX_FOLDER_IMAGES = 30

        /** Files read from one picked folder; the rest are listed as skipped. */
        internal const val MAX_FOLDER_FILES = 1000

        /** Page fetches, downloads and MCP calls in flight at once (sandbox calls have their own pool). */
        private const val IO_THREADS = 6

        internal const val MAX_PICK_CHUNK_CHARS = 200_000

        private const val MAX_FOLDER_DEPTH = 15

        internal val TEXT_EXTENSIONS =
                setOf(
                        "js", "ts", "jsx", "tsx", "svelte", "vue", "html", "css", "scss",
                        "json", "md", "txt", "py", "c", "cpp", "h", "hpp", "java", "go",
                        "rs", "rb", "php", "sh", "yml", "yaml", "toml", "ini", "csv", "sql",
                        "xml", "env", "cs", "csproj", "sln", "fs", "fsproj", "razor",
                        "swift", "kt", "dart", "nix", "kts", "gradle", "properties", "lua", "r",
                        "m", "mm", "pl", "pm", "bat", "cmd", "ps1", "psm1", "tex", "bib", "srt",
                        "vtt", "rst", "adoc", "org", "mdx", "log", "conf", "cfg", "cnf", "lock",
                        "proto", "graphql", "gql", "prisma", "tf", "hcl", "zig", "ex", "exs",
                        "erl", "hrl", "hs", "clj", "cljs", "scala", "sc", "groovy", "sass", "less",
                        "styl", "mjs", "cjs", "mts", "cts", "astro", "ipynb", "jsonc", "json5",
                        "htm", "xhtml", "svg", "plist", "asm", "s", "v", "sv", "vhd", "cmake",
                        "mk", "dockerfile", "gitignore", "editorconfig", "tsv", "jl", "nim",
                        "cr", "d", "f90", "pas", "vb", "sol", "move", "cairo", "http", "rest"
                )

        internal val IMAGE_EXTENSIONS = setOf("png", "jpg", "jpeg", "webp", "gif", "bmp")

        internal val IMAGE_MIME_TYPES =
                mapOf(
                        "png" to "image/png",
                        "jpg" to "image/jpeg",
                        "jpeg" to "image/jpeg",
                        "webp" to "image/webp",
                        "gif" to "image/gif",
                        "bmp" to "image/bmp",
                )

        internal val DOCUMENT_MIME_TYPES =
                mapOf(
                        "pdf" to "application/pdf",
                        "doc" to "application/msword",
                        "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                        "xls" to "application/vnd.ms-excel",
                        "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        "ppt" to "application/vnd.ms-powerpoint",
                        "pptx" to "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                        "zip" to "application/zip",
                        "tar" to "application/x-tar",
                        "gz" to "application/gzip",
                        "7z" to "application/x-7z-compressed",
                        "rar" to "application/vnd.rar"
                )

        private val SKIP_DIRS =
                setOf(
                        "node_modules", ".git", ".svn", "dist", "build",
                        "__pycache__", ".gradle", ".idea", ".vscode", ".vs", "vendor",
                        ".next", ".cache", "bin", "obj", "out", "target", "dist-chrome",
                        "dist-firefox"
                )
    }
}
