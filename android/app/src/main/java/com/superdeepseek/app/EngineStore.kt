package com.superdeepseek.app

import android.util.Log
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * File store for the engine's LARGE storage values (settings, memories,
 * skills, research runs … — often several MB in total).
 *
 * They used to live in one SharedPreferences XML with everything else. Every
 * `chrome.storage.local.set` rewrote that whole file, and Android waits for
 * pending SharedPreferences writes on the main thread whenever an activity
 * stops or a service starts/stops (QueuedWork). During agent work that froze
 * the UI — e.g. the chat stayed black for seconds after leaving Linux Studio.
 *
 * Here each key is its own file, writes are coalesced (latest value wins) and
 * done off the main thread, and reads come from memory. Small values stay in
 * SharedPreferences, where native code reads a few of them.
 */
internal class EngineStore(
        private val dir: File?,
        private val writeDelayMs: Long = 250L,
        private val executor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "engine-store").apply { isDaemon = true }
        },
) {
    private val cache = ConcurrentHashMap<String, String>()
    private val pending = ConcurrentHashMap<String, Any>()
    private val flushScheduled = AtomicBoolean(false)

    /** Hashed names of the files on disk (listed once, then kept up to date). */
    private val onDisk: MutableSet<String> by lazy {
        val set = ConcurrentHashMap.newKeySet<String>()
        runCatching { dir?.list()?.filter { it.length == 64 }?.let { set.addAll(it) } }
        set
    }

    fun has(key: String): Boolean = cache.containsKey(key) || (pending[key] == null && fileName(key) in onDisk)

    fun get(key: String): String? {
        cache[key]?.let { return it }
        if (pending[key] === REMOVED) return null
        val name = fileName(key)
        if (name !in onDisk) return null
        val text = runCatching { File(dir, name).readText(Charsets.UTF_8) }.getOrNull() ?: return null
        cache.putIfAbsent(key, text)
        return cache[key]
    }

    fun put(key: String, value: String) {
        cache[key] = value
        pending[key] = value
        scheduleFlush()
    }

    fun remove(key: String) {
        val known = cache.remove(key) != null || fileName(key) in onDisk || pending.containsKey(key)
        if (!known) return
        pending[key] = REMOVED
        scheduleFlush()
    }

    /** Writes everything pending now (tests, and before the process may die). */
    fun flushNow() {
        runCatching { executor.submit { flush() }.get(10, TimeUnit.SECONDS) }
    }

    /** Starts writing what is pending right away, without waiting for it. */
    fun flushSoon() {
        if (pending.isEmpty()) return
        runCatching { executor.execute { flush() } }
    }

    private fun scheduleFlush() {
        if (!flushScheduled.compareAndSet(false, true)) return
        try {
            executor.schedule({ flush() }, writeDelayMs, TimeUnit.MILLISECONDS)
        } catch (t: Throwable) {
            flushScheduled.set(false)
            Log.w(TAG, "could not schedule a write", t)
        }
    }

    private fun flush() {
        flushScheduled.set(false)
        val root = dir ?: run { pending.clear(); return }
        if (!root.isDirectory && !root.mkdirs()) {
            Log.w(TAG, "cannot create $root")
            return
        }
        val before = pending.size
        for (key in pending.keys.toList()) {
            val value = pending.remove(key) ?: continue
            val name = fileName(key)
            val file = File(root, name)
            try {
                if (value === REMOVED) {
                    file.delete()
                    onDisk.remove(name)
                } else {
                    val tmp = File(root, "$name.tmp")
                    tmp.writeText(value as String, Charsets.UTF_8)
                    if (!tmp.renameTo(file)) {
                        file.delete()
                        if (!tmp.renameTo(file)) throw java.io.IOException("rename failed")
                    }
                    onDisk.add(name)
                }
            } catch (t: Throwable) {
                Log.w(TAG, "write failed for a storage key", t)
                // Keep the newest value queued for the next attempt.
                pending.putIfAbsent(key, value)
            }
        }
        if (pending.isEmpty()) retries = 0 else if (pending.size >= before) retryLater()
    }

    private var retries = 0

    /** A failed write is retried a few times (e.g. storage briefly full). */
    private fun retryLater() {
        if (++retries > MAX_RETRIES) return
        if (!flushScheduled.compareAndSet(false, true)) return
        runCatching { executor.schedule({ flush() }, RETRY_DELAY_MS, TimeUnit.MILLISECONDS) }
                .onFailure { flushScheduled.set(false) }
    }

    companion object {
        private const val TAG = "SuperDeepSeek"
        private val REMOVED = Any()
        private const val MAX_RETRIES = 3
        private const val RETRY_DELAY_MS = 2_000L

        /** Values longer than this go to files; shorter ones stay in SharedPreferences. */
        const val LARGE_VALUE_CHARS = 2048

        fun fileName(key: String): String =
                MessageDigest.getInstance("SHA-256").digest(key.toByteArray(Charsets.UTF_8))
                        .joinToString("") { "%02x".format(it) }
    }
}
