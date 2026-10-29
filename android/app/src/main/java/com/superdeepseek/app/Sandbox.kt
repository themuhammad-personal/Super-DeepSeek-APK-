package com.superdeepseek.app

import android.annotation.SuppressLint
import android.content.Context
import android.net.ConnectivityManager
import android.os.Build
import android.os.StatFs
import android.os.SystemClock
import android.system.Os
import android.system.OsConstants
import android.util.Log
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject

/**
 * The built-in Linux sandbox: an Alpine Linux root filesystem run under proot.
 *
 * proot (ptrace-based, no root needed) ships inside the APK as
 * `libproot.so` and is exec'd from nativeLibraryDir, the one app-owned place
 * Android lets an app execute files from. The rootfs (~3.5 MB compressed) is
 * downloaded and verified on first use into noBackupFilesDir, so it never
 * ends up in cloud backups. Everything the AI runs happens inside it, as a
 * fake root, with the device's network.
 *
 * Thread-safe; one instance per process ([get]).
 */
internal class Sandbox private constructor(private val app: Context) {

    companion object {
        private const val TAG = "SdSandbox"
        const val WORKSPACE = "/root/workspace"
        const val DEFAULT_TIMEOUT_S = 120
        const val MAX_TIMEOUT_S = 1800
        const val OUTPUT_KEEP = 64 * 1024
        private const val READ_KEEP = 4 * 1024 * 1024

        // Holds only the application context, which lives as long as the process.
        @SuppressLint("StaticFieldLeak")
        @Volatile private var instance: Sandbox? = null

        fun get(context: Context): Sandbox =
                instance ?: synchronized(this) {
                    instance ?: Sandbox(context.applicationContext).also { instance = it }
                }

        /** nativeLibraryDir ends in lib/<name>; map it back to the APK ABI. */
        internal fun abiForLibDir(name: String): String? = when (name) {
            "arm64" -> "arm64-v8a"
            "arm" -> "armeabi-v7a"
            "x86_64" -> "x86_64"
            "x86" -> "x86"
            else -> null
        }

        internal fun alpineArch(abi: String): String? = when (abi) {
            "arm64-v8a" -> "aarch64"
            "armeabi-v7a" -> "armv7"
            "x86_64" -> "x86_64"
            "x86" -> "x86"
            else -> null
        }

        /** Relative sandbox paths are relative to the workspace. */
        internal fun guestPath(path: String?): String {
            val p = path?.trim().orEmpty()
            if (p.isEmpty() || p == ".") return WORKSPACE
            if (p == "~") return "/root"
            if (p.startsWith("~/")) return "/root/" + p.substring(2)
            return if (p.startsWith("/")) p else "$WORKSPACE/$p"
        }

        private val ANSI = Regex("\u001B(?:\\[[0-?]*[ -/]*[@-~]|\\][^\u0007\u001B]*(?:\u0007|\u001B\\\\)|[@-Z\\\\-_])")

        /** Colour codes and cursor movement are noise for the model. */
        internal fun stripAnsi(s: String): String = ANSI.replace(s, "").replace("\r\n", "\n")
                .split('\n').joinToString("\n") { line -> line.substringAfterLast('\r') }

        /**
         * Minimum PT_LOAD p_align (> 1) declared in an ELF binary's program headers,
         * or null when the header is truncated / non-ELF. Pure JVM; unit-tested.
         */
        internal fun minElfLoadAlign(bytes: ByteArray): Long? {
            if (bytes.size < 52 || bytes[0] != 0x7f.toByte() || bytes[1] != 'E'.code.toByte() ||
                bytes[2] != 'L'.code.toByte() || bytes[3] != 'F'.code.toByte()) return null
            val eiClass = bytes[4].toInt() and 0xff
            val order = when (bytes[5].toInt() and 0xff) {
                1 -> ByteOrder.LITTLE_ENDIAN
                2 -> ByteOrder.BIG_ENDIAN
                else -> return null
            }
            val buf = ByteBuffer.wrap(bytes).order(order)
            var minAlign: Long? = null
            if (eiClass == 2) {
                if (bytes.size < 64) return null
                val phoff = buf.getLong(32)
                val phentsize = buf.getShort(54).toInt() and 0xffff
                val phnum = buf.getShort(56).toInt() and 0xffff
                if (phoff < 0L || phentsize < 56 || phnum <= 0) return null
                for (i in 0 until phnum) {
                    val off = phoff + i.toLong() * phentsize
                    if (off < 0L || off + 56L > bytes.size) break
                    if (buf.getInt(off.toInt()) == 1) {
                        val align = buf.getLong(off.toInt() + 48)
                        if (align > 1L) minAlign = if (minAlign == null) align else minOf(minAlign, align)
                    }
                }
            } else if (eiClass == 1) {
                val phoff = buf.getInt(28).toLong() and 0xffffffffL
                val phentsize = buf.getShort(42).toInt() and 0xffff
                val phnum = buf.getShort(44).toInt() and 0xffff
                if (phoff < 0L || phentsize < 32 || phnum <= 0) return null
                for (i in 0 until phnum) {
                    val off = phoff + i.toLong() * phentsize
                    if (off < 0L || off + 32L > bytes.size) break
                    if (buf.getInt(off.toInt()) == 1) {
                        val align = buf.getInt(off.toInt() + 28).toLong() and 0xffffffffL
                        if (align > 1L) minAlign = if (minAlign == null) align else minOf(minAlign, align)
                    }
                }
            }
            return minAlign
        }

        internal fun isElfAlignedForPageSize(elfHeaderBytes: ByteArray, pageSizeBytes: Long): Boolean {
            if (pageSizeBytes <= 4096L) return true
            val align = minElfLoadAlign(elfHeaderBytes) ?: return true
            return align >= pageSizeBytes
        }
    }

    /** Receives install progress and activity changes (UI, foreground service). */
    interface Listener {
        fun onSandboxEvent(event: JSONObject) {}
        fun onActiveCountChanged(active: Int) {}
    }

    val base = File(app.noBackupFilesDir, "sandbox")
    val rootfs = File(base, "alpine")
    private val prootTmp = File(base, "ptmp")
    private val fakeProcDir = File(base, "proc")
    private val marker = File(base, "installed.json")
    private val nativeDir = File(app.applicationInfo.nativeLibraryDir ?: "")
    private val proot = File(nativeDir, "libproot.so")
    private val loader = File(nativeDir, "libproot-loader.so")
    private val loader32 = File(nativeDir, "libproot-loader32.so")

    val abi: String? get() = abiForLibDir(nativeDir.name) ?: Build.SUPPORTED_ABIS.firstOrNull()

    private val listeners = CopyOnWriteArrayList<Listener>()
    fun addListener(l: Listener) { listeners.addIfAbsent(l) }
    fun removeListener(l: Listener) { listeners.remove(l) }
    private fun emit(event: JSONObject) = listeners.forEach { runCatching { it.onSandboxEvent(event) } }

    init {
        // Keep the app alive (foreground service) while anything runs.
        addListener(object : Listener {
            override fun onActiveCountChanged(active: Int) = SandboxService.onActiveCountChanged(app, active)
        })
    }

    private val http by lazy {
        OkHttpClient.Builder()
                .connectTimeout(20, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .build()
    }

    // ── Availability and install ─────────────────────────────────────────────

    private fun runtimePageSize(): Long =
        runCatching { Os.sysconf(OsConstants._SC_PAGESIZE) }.getOrDefault(4096L).let { if (it > 0L) it else 4096L }

    private fun readElfPrefix(file: File): ByteArray? = runCatching {
        if (!file.isFile) null else FileInputStream(file).use { inp ->
            val buf = ByteArray(4096)
            var off = 0
            while (off < buf.size) {
                val n = inp.read(buf, off, buf.size - off)
                if (n <= 0) break
                off += n
            }
            buf.copyOf(off)
        }
    }.getOrNull()

    private fun isFilePageAligned(file: File, page: Long = runtimePageSize()): Boolean {
        if (page <= 4096L) return true
        val hdr = readElfPrefix(file) ?: return true
        return isElfAlignedForPageSize(hdr, page)
    }

    private fun isProotPageAligned(): Boolean {
        val page = runtimePageSize()
        return isFilePageAligned(proot, page) && isFilePageAligned(loader, page)
    }

    fun isSupported(): Boolean = proot.isFile && loader.isFile && abi?.let(::alpineArch) != null && isProotPageAligned()

    fun unsupportedReason(): String = when {
        !proot.isFile -> "This build of the app does not include the Linux sandbox runtime."
        !loader.isFile -> "The sandbox runtime is incomplete (proot loader missing)."
        abi?.let(::alpineArch) == null -> "This device's CPU architecture (${abi ?: "unknown"}) is not supported."
        !isProotPageAligned() -> {
            val pageKb = (runtimePageSize() / 1024L).coerceAtLeast(16L)
            "This device uses ${pageKb} KB memory pages, and the bundled Linux sandbox runtime (proot) is aligned for 4 KB pages."
        }
        else -> "The Linux sandbox runtime is not supported on this device."
    }

    fun isInstalled(): Boolean = marker.isFile && File(rootfs, "bin/sh").let { it.exists() || isLink(it) }

    @Volatile var installing = false
        private set
    @Volatile private var installProgress = 0.0
    @Volatile private var installPhase = ""
    private val installLock = Any()

    /** Downloads and prepares the rootfs if needed. Blocks; call off the main thread. */
    fun ensureInstalled() {
        if (isInstalled()) { ensureSession(); return }
        if (!isSupported()) throw IOException(unsupportedReason())
        synchronized(installLock) {
            // A second caller that waited for the first install just continues.
            if (!isInstalled()) {
                installing = true
                try {
                    install()
                } finally {
                    installing = false
                    progress("", 0.0)
                }
            }
        }
        ensureSession()
    }

    private fun progress(phase: String, fraction: Double) {
        installPhase = phase
        installProgress = fraction
        emit(JSONObject().put("type", "install").put("phase", phase).put("progress", fraction))
    }

    private class RootfsSource(val version: String, val sha256: String, val urls: List<String>)

    private fun rootfsSource(): RootfsSource {
        val abi = abi ?: throw IOException("Unknown CPU architecture")
        runCatching {
            val json = app.assets.open("sandbox/rootfs.json").use { it.readBytes().toString(Charsets.UTF_8) }
            val entry = JSONObject(json).getJSONObject("arches").getJSONObject(abi)
            val urls = entry.getJSONArray("urls")
            return RootfsSource(
                    entry.optString("version"),
                    entry.getString("sha256").lowercase(),
                    List(urls.length()) { urls.getString(it) })
        }
        // Not baked in by the build: ask Alpine for the current release.
        val arch = alpineArch(abi) ?: throw IOException("Unsupported architecture $abi")
        val mirror = "https://dl-cdn.alpinelinux.org/alpine"
        val yaml = httpGetString("$mirror/latest-stable/releases/$arch/latest-releases.yaml")
        var flavor = ""; var file = ""; var sha = ""; var version = ""; var branch = "latest-stable"
        var found: RootfsSource? = null
        fun flush() {
            if (found == null && flavor == "alpine-minirootfs" && file.isNotEmpty() && sha.isNotEmpty()) {
                found = RootfsSource(version, sha.lowercase(), listOf("$mirror/$branch/releases/$arch/$file"))
            }
            flavor = ""; file = ""; sha = ""; version = ""; branch = "latest-stable"
        }
        for (raw in yaml.lines()) {
            val line = raw.trim()
            if (line == "-" || line.startsWith("- ")) flush()
            val kv = line.removePrefix("-").trim()
            val i = kv.indexOf(':')
            if (i <= 0) continue
            val v = kv.substring(i + 1).trim().trim('"')
            when (kv.substring(0, i).trim()) {
                "flavor" -> flavor = v
                "file" -> file = v
                "sha256" -> sha = v
                "version" -> version = v
                "branch" -> branch = v
            }
        }
        flush()
        return found ?: throw IOException("Could not find an Alpine minirootfs for $arch")
    }

    private fun httpGetString(url: String): String {
        http.newCall(Request.Builder().url(url).build()).execute().use { r ->
            if (!r.isSuccessful) throw IOException("HTTP ${r.code} for $url")
            return r.body?.string() ?: ""
        }
    }

    private fun install() {
        base.mkdirs()
        val src = rootfsSource()
        val tarball = File(base, "rootfs.tar.gz")
        progress("download", 0.0)
        var lastError: Exception? = null
        var ok = false
        for (url in src.urls) {
            try {
                download(url, tarball, src.sha256)
                ok = true
                break
            } catch (e: Exception) {
                Log.w(TAG, "rootfs download failed from $url", e)
                lastError = e
            }
        }
        if (!ok) throw IOException("Could not download the Linux system: ${lastError?.message}", lastError)

        progress("extract", 0.0)
        val staging = File(base, "alpine.tmp")
        deleteTreeNoFollow(staging)
        val extractor = TarGzExtractor(
                symlink = { target, link -> Os.symlink(target, link.path) },
                chmod = { f, mode -> runCatching { Os.chmod(f.path, mode) } })
        var entries = 0
        tarball.inputStream().use { input ->
            extractor.extract(input, staging) {
                if (++entries % 50 == 0) progress("extract", minOf(0.95, entries / 600.0))
            }
        }
        progress("configure", 0.97)
        configure(staging)
        keepWorkspace(staging)
        deleteTreeNoFollow(rootfs)
        if (!staging.renameTo(rootfs)) throw IOException("Could not move the Linux system into place")
        tarball.delete()
        marker.writeText(JSONObject()
                .put("distro", "alpine")
                .put("version", src.version)
                .put("abi", abi)
                .put("installedAt", System.currentTimeMillis())
                .toString())
        progress("done", 1.0)
    }

    /**
     * A reinstall over a damaged system (e.g. /bin/sh deleted from inside)
     * keeps the user's files: the old workspace moves into the new system.
     */
    private fun keepWorkspace(staging: File) {
        val old = File(rootfs, "root/workspace")
        if (!old.isDirectory || isLink(old) || old.list().isNullOrEmpty()) return
        val fresh = File(staging, "root/workspace")
        deleteTreeNoFollow(fresh)
        fresh.parentFile?.mkdirs()
        if (!old.renameTo(fresh)) {
            Log.w(TAG, "could not carry the workspace over")
            fresh.mkdirs()
        }
    }

    private fun download(url: String, dest: File, sha256: String) {
        val part = File(dest.path + ".part")
        http.newCall(Request.Builder().url(url).build()).execute().use { r ->
            if (!r.isSuccessful) throw IOException("HTTP ${r.code}")
            val body = r.body ?: throw IOException("empty response")
            val total = body.contentLength()
            val digest = MessageDigest.getInstance("SHA-256")
            var done = 0L
            var lastEmit = 0L
            body.byteStream().use { input ->
                part.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        digest.update(buf, 0, n)
                        done += n
                        val now = SystemClock.uptimeMillis()
                        if (total > 0 && now - lastEmit > 150) {
                            lastEmit = now
                            progress("download", done.toDouble() / total)
                        }
                    }
                }
            }
            val got = digest.digest().joinToString("") { "%02x".format(it) }
            if (got != sha256) {
                part.delete()
                throw IOException("checksum mismatch")
            }
        }
        dest.delete()
        if (!part.renameTo(dest)) throw IOException("rename failed")
    }

    private fun configure(root: File) {
        File(root, "root/workspace").mkdirs()
        File(root, "tmp").mkdirs()
        runCatching { Os.chmod(File(root, "tmp").path, 1023 /* 01777 */) }
        writeGuestFile(root, "etc/hosts", "127.0.0.1 localhost localhost.localdomain\n::1 localhost ip6-localhost\n")
        writeResolvConf(root)
        writeGuestFile(root, "etc/profile.d/superdeepseek.sh", """
            |# Super DeepSeek sandbox defaults
            |export PS1='\w \$ '
            |export PIP_BREAK_SYSTEM_PACKAGES=1
            |export PIP_ROOT_USER_ACTION=ignore
            |export PIP_DISABLE_PIP_VERSION_CHECK=1
            |export npm_config_update_notifier=false
            |export npm_config_fund=false
            |export npm_config_audit=false
            |export PYTHONUNBUFFERED=1
            |export LANG=C.UTF-8
            |""".trimMargin())
        // Make sure the community repository (nodejs, ripgrep, …) is enabled.
        val repos = File(root, "etc/apk/repositories")
        if (repos.isFile && !isLink(repos)) {
            val lines = repos.readLines().filter { it.isNotBlank() }
            val main = lines.firstOrNull { it.trim().endsWith("/main") }
            if (main != null && lines.none { it.trim().endsWith("/community") }) {
                repos.writeText((lines + main.trim().removeSuffix("/main") + "/community").joinToString("\n") + "\n")
            }
        }
    }

    private fun writeGuestFile(root: File, rel: String, text: String) {
        val f = File(root, rel)
        f.parentFile?.mkdirs()
        if (isLink(f)) f.delete()
        f.writeText(text)
    }

    private fun writeResolvConf(root: File) {
        val servers = LinkedHashSet<String>()
        runCatching {
            val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            cm.getLinkProperties(cm.activeNetwork)?.dnsServers?.forEach { addr ->
                addr.hostAddress?.substringBefore('%')?.let { servers.add(it) }
            }
        }
        servers.add("1.1.1.1")
        servers.add("8.8.8.8")
        writeGuestFile(root, "etc/resolv.conf", servers.take(4).joinToString("") { "nameserver $it\n" })
    }

    @Volatile private var sessionReady = false

    /** Per-launch setup: current DNS servers and the fake /proc files. */
    private fun ensureSession() {
        if (sessionReady) return
        synchronized(this) {
            if (sessionReady) return
            prootTmp.mkdirs()
            runCatching { writeResolvConf(rootfs) }
            writeFakeProc()
            sessionReady = true
        }
    }

    // Android hides some of /proc from apps; programs that read them (top,
    // ps, node's os.cpus()) get plausible stand-ins instead of failing.
    private val fakeProcNames = listOf("loadavg", "stat", "uptime", "version", "vmstat")

    private fun writeFakeProc() {
        fakeProcDir.mkdirs()
        val cpus = Runtime.getRuntime().availableProcessors().coerceAtLeast(1)
        val up = SystemClock.elapsedRealtime() / 1000.0
        val stat = buildString {
            append("cpu  1957 0 2877 93280 262 342 254 87 0 0\n")
            for (i in 0 until cpus) append("cpu$i 490 0 719 23320 65 85 63 21 0 0\n")
            append("intr 1\nctxt 1\nbtime ${System.currentTimeMillis() / 1000 - up.toLong()}\n")
            append("processes 1\nprocs_running 1\nprocs_blocked 0\n")
        }
        val content = mapOf(
                "loadavg" to "0.12 0.07 0.02 2/165 765\n",
                "stat" to stat,
                "uptime" to "%.2f %.2f\n".format(java.util.Locale.US, up, up * cpus * 0.8),
                "version" to "Linux version ${System.getProperty("os.version") ?: "5.15"} (proot) #1 SMP PREEMPT\n",
                "vmstat" to "nr_free_pages 146031\nnr_inactive_anon 196744\nnr_active_anon 1234\npgpgin 1\npgpgout 1\n",
        )
        for ((name, text) in content) runCatching { File(fakeProcDir, name).writeText(text) }
    }

    private fun procReadable(name: String): Boolean =
            runCatching { FileInputStream("/proc/$name").use { it.read() }; true }.getOrDefault(false)

    // ── Running commands ─────────────────────────────────────────────────────

    class ExecResult(
            val exitCode: Int,
            val output: String,
            val omittedBytes: Long,
            val timedOut: Boolean,
            val killed: Boolean,
            val durationMs: Long,
    )

    private val running = ConcurrentHashMap<Int, Process>()
    private val killedIds = ConcurrentHashMap.newKeySet<Int>()
    private val ids = AtomicInteger(0)

    val activeCount: Int get() = running.size + jobs.values.count { it.isRunning }

    private fun activityChanged() {
        val n = activeCount
        listeners.forEach { runCatching { it.onActiveCountChanged(n) } }
    }

    private fun guestEnv(agent: Boolean): LinkedHashMap<String, String> = linkedMapOf(
            "HOME" to "/root",
            "USER" to "root",
            "LOGNAME" to "root",
            "SHELL" to "/bin/sh",
            "LANG" to "C.UTF-8",
            "PATH" to "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "TMPDIR" to "/tmp",
            "TERM" to if (agent) "dumb" else "xterm-256color",
    ).apply {
        if (agent) {
            // Non-interactive defaults: no colours, no pagers, no prompts.
            put("NO_COLOR", "1")
            put("CI", "1")
            put("PAGER", "cat")
            put("GIT_PAGER", "cat")
            put("GIT_TERMINAL_PROMPT", "0")
            put("npm_config_color", "false")
            put("npm_config_yes", "true")
        }
    }

    private fun buildProcess(guestArgv: List<String>, env: Map<String, String>): ProcessBuilder {
        val cmd = mutableListOf(
                proot.path, "--kill-on-exit", "--link2symlink", "--sysvipc", "-L", "-0",
                "-r", rootfs.path,
                "-b", "/dev", "-b", "/proc", "-b", "/sys",
                "-b", "/proc/self/fd:/dev/fd",
                "-b", "/proc/self/fd/0:/dev/stdin",
                "-b", "/proc/self/fd/1:/dev/stdout",
                "-b", "/proc/self/fd/2:/dev/stderr",
                "-b", "${rootfs.path}/tmp:/dev/shm",
                "-w", "/root")
        for (name in fakeProcNames) {
            val fake = File(fakeProcDir, name)
            if (fake.isFile && !procReadable(name)) cmd += listOf("-b", "${fake.path}:/proc/$name")
        }
        cmd += listOf("/usr/bin/env", "-i")
        for ((k, v) in env) cmd += "$k=$v"
        cmd += guestArgv
        val pb = ProcessBuilder(cmd).redirectErrorStream(true).directory(base)
        pb.environment().apply {
            clear()
            put("PATH", "/system/bin:/system/xbin")
            put("HOME", base.path)
            put("TMPDIR", prootTmp.path)
            put("PROOT_TMP_DIR", prootTmp.path)
            put("PROOT_LOADER", loader.path)
            if (loader32.isFile && isFilePageAligned(loader32)) put("PROOT_LOADER_32", loader32.path)
            put("LD_LIBRARY_PATH", nativeDir.path)
            System.getenv("ANDROID_ROOT")?.let { put("ANDROID_ROOT", it) }
            System.getenv("ANDROID_DATA")?.let { put("ANDROID_DATA", it) }
        }
        return pb
    }

    /**
     * proot itself failing to start (a packaging or device problem, not the
     * command's fault) is reported as an error the model will not retry.
     */
    private fun engineFailure(output: String): String? {
        val line = output.lineSequence().take(8).firstOrNull {
            it.startsWith("CANNOT LINK EXECUTABLE") ||
                (it.contains("page size", ignoreCase = true) && it.contains("align", ignoreCase = true))
        } ?: return null
        return "The Linux sandbox engine (proot) could not start on this device: ${line.trim().take(400)}. " +
                "This is an app problem, not something to fix from inside the sandbox; tell the user to update the app."
    }

    /** Guest shell: cd into [cwd] (created if missing), then eval the command. */
    private fun shellArgv(): List<String> = listOf(
            "/bin/sh", "-lc",
            "mkdir -p -- \"\$SD_CWD\" 2>/dev/null; cd -- \"\$SD_CWD\" || exit 97; " +
                    "__sd_c=\$SD_CMD; unset SD_CWD SD_CMD; eval \"\$__sd_c\"")

    /**
     * Runs [command] with /bin/sh inside the sandbox and waits for it.
     * stdout and stderr are merged; beyond [maxOutput] bytes the middle is
     * dropped (the head and the tail are what matter for logs and errors).
     */
    fun exec(
            command: String,
            cwd: String = WORKSPACE,
            timeoutSec: Int = DEFAULT_TIMEOUT_S,
            stdin: ByteArray? = null,
            maxOutput: Int = OUTPUT_KEEP,
            extraEnv: Map<String, String> = emptyMap(),
            onOutput: ((String) -> Unit)? = null,
            announce: Boolean = false,
    ): ExecResult {
        ensureInstalled()
        val env = guestEnv(agent = true).apply {
            putAll(extraEnv)
            put("SD_CWD", guestPath(cwd))
            put("SD_CMD", command)
        }
        val started = SystemClock.elapsedRealtime()
        val process = buildProcess(shellArgv(), env).start()
        val id = ids.incrementAndGet()
        running[id] = process
        activityChanged()
        // Agent commands are mirrored live to the Studio terminal.
        if (announce) emit(JSONObject().put("type", "exec").put("phase", "start").put("id", id).put("command", command).put("cwd", guestPath(cwd)))
        val sink: ((String) -> Unit)? = if (!announce) onOutput else { text ->
            onOutput?.invoke(text)
            emit(JSONObject().put("type", "exec").put("phase", "output").put("id", id).put("text", text))
        }
        try {
            val collector = OutputCollector(maxOutput)
            val reader = Thread({ pump(process.inputStream, collector, sink) }, "sandbox-out-$id").apply { start() }
            Thread({
                runCatching { process.outputStream.use { out -> if (stdin != null) out.write(stdin) } }
            }, "sandbox-in-$id").start()
            val timeout = timeoutSec.coerceIn(1, MAX_TIMEOUT_S).toLong()
            val finished = process.waitFor(timeout, TimeUnit.SECONDS)
            if (!finished) terminate(process)
            reader.join(3000)
            val exit = runCatching { process.exitValue() }.getOrDefault(-1)
            if (exit != 0) engineFailure(collector.text())?.let { msg ->
                if (announce) emit(JSONObject().put("type", "exec").put("phase", "end").put("id", id).put("exitCode", exit).put("timedOut", false))
                throw IOException(msg)
            }
            if (announce) emit(JSONObject().put("type", "exec").put("phase", "end").put("id", id).put("exitCode", exit).put("timedOut", !finished))
            return ExecResult(
                    exitCode = exit,
                    output = collector.text(),
                    omittedBytes = collector.omitted,
                    timedOut = !finished,
                    killed = killedIds.remove(id),
                    durationMs = SystemClock.elapsedRealtime() - started)
        } finally {
            running.remove(id)
            activityChanged()
        }
    }

    private fun terminate(p: Process) {
        p.destroy()
        if (!p.waitFor(3, TimeUnit.SECONDS)) {
            p.destroyForcibly()
            p.waitFor(2, TimeUnit.SECONDS)
        }
    }

    private fun pump(input: InputStream, collector: OutputCollector, onOutput: ((String) -> Unit)?) {
        val buf = ByteArray(16 * 1024)
        // A character split across two reads must not turn into two garbage characters.
        val text = Utf8Chunker()
        try {
            input.use {
                while (true) {
                    val n = it.read(buf)
                    if (n < 0) break
                    collector.write(buf, n)
                    if (onOutput != null) {
                        val chunk = text.decode(buf, n)
                        if (chunk.isNotEmpty()) runCatching { onOutput(chunk) }
                    }
                }
            }
        } catch (_: IOException) {
            // Process killed; keep what we have.
        }
    }

    /** Keeps the first and the last [limit]/2 bytes of a stream. */
    internal class OutputCollector(private val limit: Int) {
        private val head = java.io.ByteArrayOutputStream()
        private val tail = ByteArray(limit / 2)
        private var tailLen = 0L
        var omitted = 0L
            private set
        var total = 0L
            private set

        @Synchronized
        fun write(buf: ByteArray, n: Int) {
            total += n
            var off = 0
            val headRoom = limit / 2 - head.size()
            if (headRoom > 0) {
                val k = minOf(headRoom, n)
                head.write(buf, 0, k)
                off = k
            }
            for (i in off until n) {
                tail[(tailLen % tail.size).toInt()] = buf[i]
                tailLen++
            }
            omitted = maxOf(0L, tailLen - tail.size)
        }

        @Synchronized
        fun text(): String {
            val t = if (tailLen <= tail.size) tail.copyOf(tailLen.toInt()) else {
                val start = (tailLen % tail.size).toInt()
                tail.copyOfRange(start, tail.size) + tail.copyOfRange(0, start)
            }
            val h = head.toString("UTF-8")
            val tt = String(t, Charsets.UTF_8)
            val size = if (omitted >= 1024) "${omitted / 1024} KB" else "$omitted bytes"
            return if (omitted > 0) "$h\n\n[… $size of output omitted …]\n\n$tt" else h + tt
        }
    }

    // ── Background jobs (servers, watchers, long builds) ─────────────────────

    inner class Job(val id: String, val command: String, val cwd: String, internal val process: Process) {
        val startedAt = System.currentTimeMillis()
        internal val log = OutputCollector(OUTPUT_KEEP)
        private val fresh = StringBuilder()
        @Volatile var exitCode: Int? = null
            internal set
        val isRunning: Boolean get() = exitCode == null

        internal fun append(s: String) = synchronized(fresh) {
            fresh.append(s)
            if (fresh.length > 32 * 1024) fresh.delete(0, fresh.length - 32 * 1024)
        }

        /** Output since the previous call (at most the last 32 KB). */
        fun takeNew(): String = synchronized(fresh) { fresh.toString().also { fresh.setLength(0) } }
    }

    private val jobs = ConcurrentHashMap<String, Job>()
    private val jobSeq = AtomicInteger(0)

    fun startJob(command: String, cwd: String = WORKSPACE): Job {
        ensureInstalled()
        val env = guestEnv(agent = true).apply {
            put("SD_CWD", guestPath(cwd))
            put("SD_CMD", command)
        }
        val process = buildProcess(shellArgv(), env).start()
        runCatching { process.outputStream.close() }
        val job = Job("job${jobSeq.incrementAndGet()}", command, guestPath(cwd), process)
        jobs[job.id] = job
        // Keep the list bounded: forget the oldest finished jobs.
        jobs.values.filter { !it.isRunning }.sortedBy { it.startedAt }.dropLast(10).forEach { jobs.remove(it.id) }
        activityChanged()
        Thread({
            pump(process.inputStream, job.log) { job.append(it) }
            job.exitCode = runCatching { process.waitFor() }.getOrDefault(-1)
            activityChanged()
            emit(JSONObject().put("type", "job-exit").put("id", job.id).put("exitCode", job.exitCode))
        }, "sandbox-${job.id}").start()
        return job
    }

    fun job(id: String): Job? = jobs[id.trim()]

    fun listJobs(): List<Job> = jobs.values.sortedBy { it.startedAt }

    fun killJob(id: String): Boolean {
        val job = jobs[id.trim()] ?: return false
        if (job.isRunning) terminate(job.process)
        return true
    }

    /** Stop: every foreground command and background job. */
    fun killAll(): Int {
        var n = 0
        for ((id, p) in running) {
            killedIds.add(id)
            Thread { terminate(p) }.start()
            n++
        }
        for (job in jobs.values) if (job.isRunning) {
            Thread { terminate(job.process) }.start()
            n++
        }
        return n
    }

    /**
     * The Studio terminal's shell (pipes, no PTY: line-based programs work,
     * full-screen ones like vim do not), started in [cwd] (the folder the previous
     * one was in, after a Stop). No prompt: the terminal draws its own and
     * learns when a command ends from [ShellProtocol] markers.
     */
    fun startShell(cwd: String = WORKSPACE): Process {
        ensureInstalled()
        val env = guestEnv(agent = false).apply {
            put("TERM", "dumb")
            put("PAGER", "cat")
            put("GIT_PAGER", "cat")
            put("PYTHONUNBUFFERED", "1")
            put("SD_CWD", guestPath(cwd))
        }
        val argv = listOf("/bin/sh", "-lc",
                "mkdir -p -- \"\$SD_CWD\" 2>/dev/null; cd -- \"\$SD_CWD\" 2>/dev/null || cd -- $WORKSPACE; unset SD_CWD; " +
                        "PS1=''; PS2=''; export PS1 PS2; exec /bin/sh -i 2>&1")
        return buildProcess(argv, env).start()
    }

    // ── Host-side file access (Studio, export) ───────────────────────────────

    /**
     * The host file behind a guest path, or null when it resolves outside the
     * Linux system (e.g. through an absolute symlink).
     */
    fun hostFile(guest: String): File? {
        val root = rootfs.canonicalFile
        val rel = guestPath(guest).trimStart('/')
        val f = if (rel.isEmpty()) root else File(root, rel)
        val c = runCatching { f.canonicalFile }.getOrNull() ?: return null
        return if (c.path == root.path || c.path.startsWith(root.path + File.separator)) c else null
    }

    /** Copies a sandbox file into the phone's Downloads folder; returns the saved name. */
    fun exportToDownloads(guest: String, displayName: String? = null): String {
        val src = hostFile(guest) ?: throw IOException("${guestPath(guest)} is outside the sandbox")
        if (!src.isFile) throw IOException("${guestPath(guest)} is not a file")
        val name = (displayName?.trim()?.takeIf { it.isNotEmpty() } ?: src.name)
                .replace('/', '_').replace('\\', '_').take(180)
        val mime = android.webkit.MimeTypeMap.getSingleton()
                .getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"
        if (Build.VERSION.SDK_INT >= 29) {
            val resolver = app.contentResolver
            val values = android.content.ContentValues().apply {
                put(android.provider.MediaStore.Downloads.DISPLAY_NAME, name)
                put(android.provider.MediaStore.Downloads.MIME_TYPE, mime)
                put(android.provider.MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = resolver.insert(android.provider.MediaStore.Downloads.getContentUri(android.provider.MediaStore.VOLUME_EXTERNAL_PRIMARY), values)
                    ?: throw IOException("could not create the download")
            try {
                resolver.openOutputStream(uri)?.use { out -> src.inputStream().use { it.copyTo(out, 64 * 1024) } }
                        ?: throw IOException("could not write the download")
                values.clear()
                values.put(android.provider.MediaStore.Downloads.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
            } catch (e: Exception) {
                runCatching { resolver.delete(uri, null, null) }
                throw e
            }
            return name
        }
        val out = uniqueFileIn(LegacyDownloads.folder(app), name)
        src.copyTo(out)
        return out.name
    }

    // ── Files (through the guest, so its symlinks resolve correctly) ─────────

    /**
     * The whole file. A file larger than the read limit is an error, never a
     * shortened copy: edit_file writes what it read back, and a copy with its
     * middle cut out would silently destroy the file.
     */
    fun readFile(path: String): String {
        // Straight from disk when the file is plainly inside the rootfs: exact
        // bytes, and no proot warning (stderr is merged into exec output) can
        // end up inside the text that edit_file writes back.
        val guest = guestPath(path)
        val bound = listOf("/dev", "/proc", "/sys").any { guest == it || guest.startsWith("$it/") }
        val host = if (bound) null else hostFile(path)
        if (host != null && host.isFile) {
            if (host.length() > READ_KEEP) throw IOException(tooLargeToRead(path))
            return host.readText(Charsets.UTF_8)
        }
        val r = exec("cat -- \"\$SD_PATH\"", extraEnv = mapOf("SD_PATH" to guestPath(path)), timeoutSec = 60, maxOutput = READ_KEEP)
        if (r.exitCode != 0) throw IOException(r.output.trim().ifEmpty { "cannot read ${guestPath(path)}" })
        if (r.omittedBytes > 0) throw IOException(tooLargeToRead(path))
        return r.output
    }

    private fun tooLargeToRead(path: String): String =
            "${guestPath(path)} is larger than ${READ_KEEP / (1024 * 1024)} MB. " +
                    "Work on it with run instead (e.g. sed -n '1,400p', grep -n, head/tail, or a Python script)."

    fun writeFile(path: String, content: ByteArray) {
        val r = exec(
                "mkdir -p -- \"\$(dirname -- \"\$SD_PATH\")\" && cat > \"\$SD_PATH\"",
                extraEnv = mapOf("SD_PATH" to guestPath(path)), timeoutSec = 60, stdin = content)
        if (r.exitCode != 0) throw IOException(r.output.trim().ifEmpty { "cannot write ${guestPath(path)}" })
        // Studio shows the write in its terminal and refreshes Files / Preview.
        emit(JSONObject().put("type", "file").put("path", guestPath(path)).put("bytes", content.size))
    }

    // ── Status and maintenance ───────────────────────────────────────────────

    fun status(): JSONObject {
        val info = runCatching { JSONObject(marker.readText()) }.getOrNull()
        return JSONObject()
                .put("supported", isSupported())
                .put("installed", isInstalled())
                .put("installing", installing)
                .put("phase", installPhase)
                .put("progress", installProgress)
                .put("distro", "Alpine Linux")
                .put("version", info?.optString("version") ?: "")
                .put("abi", abi ?: "")
                .put("workspace", WORKSPACE)
                .put("active", activeCount)
                .put("freeBytes", runCatching { StatFs(app.noBackupFilesDir.path).availableBytes }.getOrDefault(-1L))
                .apply { if (!isSupported()) put("reason", unsupportedReason()) }
    }

    /** Deletes the whole Linux system (the workspace too). */
    fun reset() {
        killAll()
        // Let the processes go before their files do.
        val deadline = SystemClock.uptimeMillis() + 5000
        while (activeCount > 0 && SystemClock.uptimeMillis() < deadline) Thread.sleep(100)
        synchronized(installLock) {
            marker.delete()
            deleteTreeNoFollow(rootfs)
            deleteTreeNoFollow(File(base, "alpine.tmp"))
            deleteTreeNoFollow(prootTmp)
            File(base, "rootfs.tar.gz").delete()
            sessionReady = false
        }
        // Studio (if open) starts a fresh terminal; the settings card refreshes.
        emit(JSONObject().put("type", "reset"))
    }

    private fun isLink(f: File): Boolean = runCatching { java.nio.file.Files.isSymbolicLink(f.toPath()) }.getOrDefault(false)
}
