package com.superdeepseek.app

import android.content.Intent
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Things the Android side asks the chat page to do: text or files shared into
 * the app, launcher shortcuts and deep links. They are plain JSON handed to
 * `window.__sdNative.receive(json)` (bds/sd-native.js), which knows the
 * engine; queued natively until the engine is in the page.
 *
 * Kept free of Activity state so the parsing is unit-testable.
 */

/** Launcher-shortcut actions (res/xml/shortcuts.xml → extra `bds_action`). */
internal const val EXTRA_BDS_ACTION = "bds_action"

internal val KNOWN_SHORTCUT_ACTIONS = setOf("new_chat", "deep_research")

/** What an incoming Intent asks for, before any file is read. */
internal sealed class IncomingRequest {
    /** Text and/or files shared from another app (SEND, SEND_MULTIPLE, PROCESS_TEXT). */
    data class Share(val text: String, val streams: List<Uri>) : IncomingRequest()

    /** A launcher shortcut. */
    data class Shortcut(val action: String) : IncomingRequest()

    /** A chat.deepseek.com link opened with the app. */
    data class DeepLink(val url: String) : IncomingRequest()
}

/** Join a shared subject and text the way a user would paste them. */
internal fun joinSharedText(subject: String?, text: String?): String {
    val s = subject?.trim().orEmpty()
    val t = text?.trim().orEmpty()
    return when {
        s.isEmpty() -> t
        t.isEmpty() -> s
        t.contains(s) -> t
        else -> "$s\n\n$t"
    }
}

/** True for links the app should open in its own chat page. */
internal fun isChatDeepLink(uri: Uri?): Boolean {
    uri ?: return false
    if (uri.scheme?.lowercase() != "https") return false
    return uri.host?.lowercase() == "chat.deepseek.com"
}

/**
 * The shared payload Android put in [intent], or null when it is an ordinary
 * launch. Stream URIs are collected here but read later, off the main thread.
 */
@Suppress("DEPRECATION")
internal fun parseIncomingIntent(intent: Intent?): IncomingRequest? {
    intent ?: return null
    when (intent.action) {
        Intent.ACTION_SEND -> {
            val text = joinSharedText(
                intent.getStringExtra(Intent.EXTRA_SUBJECT),
                intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString(),
            )
            val stream = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
            val streams = listOfNotNull(stream) + clipDataUris(intent).filter { it != stream }
            if (text.isEmpty() && streams.isEmpty()) return null
            return IncomingRequest.Share(text, streams.distinct())
        }
        Intent.ACTION_SEND_MULTIPLE -> {
            val text = joinSharedText(
                intent.getStringExtra(Intent.EXTRA_SUBJECT),
                intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString(),
            )
            val listed = intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
            val streams = (listed + clipDataUris(intent)).distinct()
            if (text.isEmpty() && streams.isEmpty()) return null
            return IncomingRequest.Share(text, streams)
        }
        Intent.ACTION_PROCESS_TEXT -> {
            val text = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()?.trim().orEmpty()
            return if (text.isEmpty()) null else IncomingRequest.Share(text, emptyList())
        }
        Intent.ACTION_VIEW -> {
            val data = intent.data
            if (isChatDeepLink(data)) return IncomingRequest.DeepLink(data.toString())
        }
    }
    val action = intent.getStringExtra(EXTRA_BDS_ACTION)?.trim()?.lowercase()
    if (action != null && action in KNOWN_SHORTCUT_ACTIONS) return IncomingRequest.Shortcut(action)
    return null
}

private fun clipDataUris(intent: Intent): List<Uri> {
    val clip = intent.clipData ?: return emptyList()
    return (0 until clip.itemCount).mapNotNull { clip.getItemAt(it)?.uri }
}

/** Upper bound on files accepted from one share (the web chat allows 50 per session). */
internal const val MAX_SHARED_FILES = 20

/** The JSON `window.__sdNative.receive` gets for a share. */
internal fun buildShareActionJson(
    text: String,
    files: List<PickedFile>,
    skipped: List<SkippedFile>,
): String {
    val arr = JSONArray()
    for (f in files) {
        arr.put(
            JSONObject()
                .put("name", f.name)
                .put("mime", f.mime ?: "application/octet-stream")
                .put("size", f.size)
                .put("text", f.text)
                .put("blob", f.blobPath ?: JSONObject.NULL)
                .put("content", if (f.blobPath == null) f.content else "")
                .put("encoding", f.encoding ?: JSONObject.NULL)
        )
    }
    val sk = JSONArray()
    for (s in skipped) sk.put(JSONObject().put("name", s.name).put("reason", s.reason))
    return JSONObject()
        .put("type", "share")
        .put("text", text)
        .put("files", arr)
        .put("skipped", sk)
        .toString()
}

internal fun buildShortcutActionJson(action: String): String =
    JSONObject().put("type", "shortcut").put("action", action).toString()

internal fun buildDeepLinkActionJson(url: String): String =
    JSONObject().put("type", "open").put("url", url).toString()

/**
 * Script delivering [actionJson] to the page. The glue may still be booting,
 * so it waits (up to ~30 s) for `window.__sdNative.receive` to appear.
 */
internal fun buildPageActionScript(actionJson: String): String {
    val quoted = JSONObject.quote(actionJson)
    return "(function(){var j=$quoted,n=0;(function go(){var s=window.__sdNative;" +
        "if(s&&typeof s.receive==='function'){try{s.receive(j)}catch(e){console.error('[SD] action failed',e)}return}" +
        "if(++n<120)setTimeout(go,250);else console.warn('[SD] native glue missing; action dropped')})()})();"
}

/**
 * Delete camera captures ([prefix]*.jpg in [dir]) older than [maxAgeMillis].
 * They were written for the WebView file chooser and never cleaned up.
 * Returns how many files were removed.
 */
internal fun cleanupOldCaptures(
    dir: File,
    nowMillis: Long = System.currentTimeMillis(),
    maxAgeMillis: Long = 24L * 60 * 60 * 1000,
    prefix: String = "capture-",
): Int {
    val files = dir.listFiles() ?: return 0
    var removed = 0
    for (f in files) {
        if (!f.isFile || !f.name.startsWith(prefix) || !f.name.endsWith(".jpg")) continue
        if (nowMillis - f.lastModified() < maxAgeMillis) continue
        if (f.delete()) removed++
    }
    return removed
}

/**
 * Renderer-loss recovery recreates the Activity; a renderer that dies again
 * right away must not turn that into an endless loop. Process-wide on purpose
 * (a recreated Activity is a new instance).
 */
internal object RendererCrashGuard {
    private const val WINDOW_MS = 60_000L
    private const val MAX_IN_WINDOW = 3
    private val times = ArrayDeque<Long>()

    @Synchronized
    fun shouldRecover(nowMillis: Long): Boolean {
        while (times.isNotEmpty() && nowMillis - times.first() > WINDOW_MS) times.removeFirst()
        times.addLast(nowMillis)
        return times.size <= MAX_IN_WINDOW
    }

    @Synchronized
    internal fun reset() = times.clear()
}
