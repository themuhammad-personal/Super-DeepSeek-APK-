package com.superdeepseek.app

import java.net.InetSocketAddress
import java.net.Socket
import org.json.JSONArray
import org.json.JSONObject

/**
 * The sandbox as a built-in MCP server ("sandbox", url `sandbox://linux`).
 *
 * The engine already knows how to discover MCP tools, put them in the
 * system prompt, parse the model's tool calls, run them and send the result
 * back automatically — so exposing the sandbox this way gives the model a
 * full agent loop (run → read the result → next step) with no new protocol.
 *
 * Results use the MCP shape `{content:[{type:"text",text}], isError}`.
 */
internal class SandboxTools(
        private val sandbox: Sandbox,
        /** Opens a URL served from inside the sandbox in the app; false if it could not. */
        private val openPreview: (url: String) -> Boolean = { false },
) {

    companion object {
        const val SERVER_URL = "sandbox://linux"
        const val SERVER_NAME = "sandbox"

        fun isSandboxUrl(url: String?): Boolean {
            val u = url?.trim()?.lowercase().orEmpty()
            return u == SERVER_NAME || u.startsWith("sandbox:")
        }

        private val PACKAGE_NAME = Regex("^[A-Za-z0-9][A-Za-z0-9._+\\-]*(?:[<>=~]{1,2}[A-Za-z0-9._\\-]+)?$")

        private fun schema(vararg props: Pair<String, JSONObject>, required: List<String> = emptyList()): JSONObject =
                JSONObject().put("type", "object")
                        .put("properties", JSONObject().apply { props.forEach { (k, v) -> put(k, v) } })
                        .put("required", JSONArray(required))

        private fun str(desc: String) = JSONObject().put("type", "string").put("description", desc)
        private fun int(desc: String) = JSONObject().put("type", "integer").put("description", desc)
        private fun bool(desc: String) = JSONObject().put("type", "boolean").put("description", desc)

        private fun tool(name: String, desc: String, schema: JSONObject) =
                JSONObject().put("name", name).put("description", desc).put("inputSchema", schema)

        internal fun text(s: String, isError: Boolean = false): JSONObject = JSONObject()
                .put("content", JSONArray().put(JSONObject().put("type", "text").put("text", s)))
                .put("isError", isError)

        internal fun formatDuration(ms: Long): String =
                if (ms < 1000) "${ms}ms" else if (ms < 60_000) "%.1fs".format(java.util.Locale.US, ms / 1000.0)
                else "${ms / 60_000}m ${(ms / 1000) % 60}s"

        /**
         * Replace exactly one occurrence of [old] (or all with [all]).
         * Returns the new text, or an error message.
         */
        internal fun applyEdit(text: String, old: String, new: String, all: Boolean): Result<Pair<String, Int>> {
            if (old.isEmpty()) return Result.failure(IllegalArgumentException("old_text must not be empty"))
            var count = 0
            var i = text.indexOf(old)
            while (i >= 0) { count++; i = text.indexOf(old, i + old.length) }
            if (count == 0) {
                // Tolerate CRLF files edited with LF snippets.
                if (text.contains("\r\n") && !old.contains("\r\n")) {
                    return applyEdit(text, old.replace("\n", "\r\n"), toCrlf(new), all)
                }
                return Result.failure(IllegalArgumentException(
                        "old_text was not found in the file. Read the file again and copy the exact text (including whitespace)."))
            }
            if (count > 1 && !all) return Result.failure(IllegalArgumentException(
                    "old_text occurs $count times. Include more surrounding lines so it is unique, or set replace_all=true."))
            return Result.success((if (all) text.replace(old, new) else text.replaceFirst(old, new)) to count)
        }

        /** [s] with every line ending as CRLF (a snippet that already has CRLF stays unchanged). */
        internal fun toCrlf(s: String): String = s.replace("\r\n", "\n").replace("\n", "\r\n")

        /** 1-based line window with numbered lines. */
        internal fun window(text: String, offsetLine: Int, maxLines: Int): String {
            if (text.isEmpty()) return "[empty file]\n"
            val lines = text.split('\n').let { if (it.isNotEmpty() && it.last().isEmpty() && text.endsWith("\n")) it.dropLast(1) else it }
            val start = (offsetLine - 1).coerceIn(0, maxOf(0, lines.size))
            val end = minOf(lines.size, start + maxLines)
            val width = end.toString().length
            val sb = StringBuilder()
            for (i in start until end) {
                val line = lines[i].let { if (it.length > 2000) it.take(2000) + " …[line truncated]" else it }
                sb.append((i + 1).toString().padStart(width)).append("  ").append(line).append('\n')
            }
            if (end < lines.size) sb.append("[… ${lines.size - end} more lines; continue with offset_line=${end + 1}]\n")
            if (lines.isEmpty() || start >= lines.size) sb.append("[empty: the file has ${lines.size} lines]\n")
            return sb.toString()
        }
    }

    fun listTools(): JSONArray = JSONArray()
            .put(tool("run",
                    "Run a shell command in your Linux sandbox (Alpine Linux, you are root, internet available). " +
                            "Files and installed packages persist between calls. Default directory: ${Sandbox.WORKSPACE}. " +
                            "Install tools with install_packages (apk) or pip/npm. stdout+stderr and the exit code are returned. " +
                            "For servers, watchers or anything that does not exit, set background=true, then use job to read its output.",
                    schema(
                            "command" to str("Shell command (sh). Chain with && ; multi-line scripts are fine."),
                            "cwd" to str("Working directory (default ${Sandbox.WORKSPACE}; relative paths are inside it)."),
                            "timeout_seconds" to int("Max run time, default ${Sandbox.DEFAULT_TIMEOUT_S}, max ${Sandbox.MAX_TIMEOUT_S}."),
                            "background" to bool("Start and return immediately with a job id (for servers and long builds)."),
                            required = listOf("command"))))
            .put(tool("job",
                    "Background jobs started with run(background=true): read new output (action=output), stop one (action=kill), or list them (action=list).",
                    schema(
                            "action" to str("output | kill | list"),
                            "job_id" to str("Job id, e.g. job1 (not needed for list)."),
                            "wait_seconds" to int("For output: wait up to this long (max 60) for the job to print something or exit."),
                            required = listOf("action"))))
            .put(tool("read_file",
                    "Read a text file from the sandbox with line numbers. Use offset_line/max_lines for big files.",
                    schema(
                            "path" to str("File path (relative to ${Sandbox.WORKSPACE} or absolute)."),
                            "offset_line" to int("First line to return (1-based), default 1."),
                            "max_lines" to int("Lines to return, default 400, max 2000."),
                            required = listOf("path"))))
            .put(tool("write_file",
                    "Create or overwrite a file in the sandbox with the given content (parent directories are created).",
                    schema(
                            "path" to str("File path (relative to ${Sandbox.WORKSPACE} or absolute)."),
                            "content" to str("The complete file content."),
                            required = listOf("path", "content"))))
            .put(tool("edit_file",
                    "Replace an exact snippet in a sandbox file. old_text must match exactly once (whitespace included) unless replace_all=true. Prefer this over rewriting big files.",
                    schema(
                            "path" to str("File path."),
                            "old_text" to str("Exact text to replace."),
                            "new_text" to str("Replacement text."),
                            "replace_all" to bool("Replace every occurrence."),
                            required = listOf("path", "old_text", "new_text"))))
            .put(tool("list_dir",
                    "List a directory tree in the sandbox (node_modules and .git are skipped).",
                    schema(
                            "path" to str("Directory (default ${Sandbox.WORKSPACE})."),
                            "depth" to int("How deep to list, default 2, max 6."))))
            .put(tool("install_packages",
                    "Install Alpine packages with apk (e.g. python3 py3-pip nodejs npm git build-base ripgrep sqlite ffmpeg).",
                    schema("packages" to JSONObject().put("type", "array").put("items", JSONObject().put("type", "string"))
                            .put("description", "Package names."), required = listOf("packages"))))
            .put(tool("preview",
                    "Show something to the user in the app's preview window: a web server running in the sandbox " +
                            "(give port; start it first with run background=true), or an HTML, Markdown, image or video file " +
                            "or a folder (give file; pages load their relative CSS/JS/images, no server needed).",
                    schema("port" to int("Port the server listens on (127.0.0.1)."),
                            "path" to str("Optional URL path for port, e.g. /index.html"),
                            "file" to str("A file or folder in the sandbox to show instead of a server (relative to ${Sandbox.WORKSPACE} or absolute)."))))
            .put(tool("export_file",
                    "Save a file from the sandbox to the phone's Downloads folder so the user can open or share it (documents, images, archives, APKs, …).",
                    schema("path" to str("File path in the sandbox."),
                            "name" to str("Optional file name for the download."),
                            required = listOf("path"))))
            .put(tool("status",
                    "Sandbox status: Linux version, free space, running jobs.",
                    schema()))

    /** Runs a tool. Never throws: failures come back as MCP errors. */
    fun call(name: String, args: JSONObject): JSONObject = try {
        when (name) {
            "run" -> run(args)
            "job" -> job(args)
            "read_file" -> readFile(args)
            "write_file" -> writeFile(args)
            "edit_file" -> editFile(args)
            "list_dir" -> listDir(args)
            "install_packages" -> installPackages(args)
            "preview" -> preview(args)
            "export_file" -> exportFile(args)
            "status" -> status()
            else -> text("Unknown sandbox tool: $name", isError = true)
        }
    } catch (t: Throwable) {
        text("Sandbox error: ${t.message ?: t.javaClass.simpleName}", isError = true)
    }

    private fun required(args: JSONObject, key: String): String {
        if (!args.has(key) || args.isNull(key)) throw IllegalArgumentException("missing argument \"$key\"")
        return args.optString(key)
    }

    private fun formatExec(header: String, r: Sandbox.ExecResult): String {
        val out = Sandbox.stripAnsi(r.output).trimEnd()
        val status = when {
            r.killed -> "stopped by the user"
            r.timedOut -> "timed out after ${formatDuration(r.durationMs)} (process killed; use a larger timeout_seconds or background=true)"
            else -> "exit ${r.exitCode} · ${formatDuration(r.durationMs)}"
        }
        return buildString {
            append(header).append('\n')
            if (out.isNotEmpty()) append(out).append('\n')
            append('[').append(status).append(']')
        }
    }

    private fun run(args: JSONObject): JSONObject {
        val command = required(args, "command")
        if (command.isBlank()) throw IllegalArgumentException("command is empty")
        val cwd = args.optString("cwd").ifBlank { Sandbox.WORKSPACE }
        if (args.optBoolean("background")) {
            val job = sandbox.startJob(command, cwd)
            // Give it a moment so immediate failures (typos, missing files) are visible.
            Thread.sleep(1500)
            val early = Sandbox.stripAnsi(job.takeNew()).trimEnd()
            val state = if (job.isRunning) "running" else "exited with code ${job.exitCode}"
            return text(buildString {
                append("Started ${job.id} in ${job.cwd}: $command\n")
                if (early.isNotEmpty()) append(early).append('\n')
                append("[${job.id} $state — use job(action=output, job_id=${job.id}) for more]")
            })
        }
        val timeout = if (args.has("timeout_seconds")) args.optInt("timeout_seconds", Sandbox.DEFAULT_TIMEOUT_S) else Sandbox.DEFAULT_TIMEOUT_S
        val r = sandbox.exec(command, cwd, timeout, announce = true)
        return text(formatExec("$ $command", r))
    }

    private fun job(args: JSONObject): JSONObject {
        val action = args.optString("action").ifBlank { if (args.has("job_id")) "output" else "list" }
        if (action == "list") {
            val jobs = sandbox.listJobs()
            if (jobs.isEmpty()) return text("No background jobs.")
            return text(jobs.joinToString("\n") { j ->
                "${j.id}  ${if (j.isRunning) "running" else "exited ${j.exitCode}"}  ${j.cwd}  $ ${j.command.take(120)}"
            })
        }
        val id = required(args, "job_id")
        val job = sandbox.job(id) ?: return text("No job \"$id\". Use job(action=list).", isError = true)
        return when (action) {
            "kill", "stop" -> {
                sandbox.killJob(id)
                text("Stopped ${job.id}.")
            }
            else -> {
                val wait = args.optInt("wait_seconds", 0).coerceIn(0, 60)
                val deadline = System.currentTimeMillis() + wait * 1000L
                var out = job.takeNew()
                while (out.isEmpty() && job.isRunning && System.currentTimeMillis() < deadline) {
                    Thread.sleep(300)
                    out = job.takeNew()
                }
                val state = if (job.isRunning) "running" else "exited with code ${job.exitCode}"
                val body = Sandbox.stripAnsi(out).trimEnd().ifEmpty { "(no new output)" }
                text("$body\n[${job.id} $state]")
            }
        }
    }

    private fun readFile(args: JSONObject): JSONObject {
        val path = Sandbox.guestPath(required(args, "path"))
        val content = sandbox.readFile(path)
        if (content.indexOf('\u0000') in 0 until minOf(content.length, 8000)) {
            return text("$path looks like a binary file (${content.length} bytes). Inspect it with run (e.g. file, xxd | head, or a Python script).")
        }
        val offset = args.optInt("offset_line", 1).coerceAtLeast(1)
        val max = args.optInt("max_lines", 400).coerceIn(1, 2000)
        return text("$path\n" + window(content, offset, max))
    }

    private fun writeFile(args: JSONObject): JSONObject {
        val path = Sandbox.guestPath(required(args, "path"))
        val content = required(args, "content")
        val bytes = content.toByteArray(Charsets.UTF_8)
        sandbox.writeFile(path, bytes)
        return text("Wrote $path (${bytes.size} bytes, ${content.count { it == '\n' } + if (content.endsWith("\n") || content.isEmpty()) 0 else 1} lines).")
    }

    private fun editFile(args: JSONObject): JSONObject {
        val path = Sandbox.guestPath(required(args, "path"))
        val old = required(args, "old_text")
        val new = required(args, "new_text")
        val current = sandbox.readFile(path)
        // Text that went through a lossy decode would be written back damaged.
        if (current.indexOf('\u0000') >= 0 || current.indexOf('\uFFFD') >= 0) {
            return text("$path is binary or not UTF-8 text, so edit_file could damage it. Change it with run instead (e.g. sed, or a Python script).", isError = true)
        }
        val edited = applyEdit(current, old, new, args.optBoolean("replace_all")).getOrElse {
            return text("$path: ${it.message}", isError = true)
        }
        sandbox.writeFile(path, edited.first.toByteArray(Charsets.UTF_8))
        return text("Edited $path (${edited.second} replacement${if (edited.second == 1) "" else "s"}).")
    }

    private fun listDir(args: JSONObject): JSONObject {
        val path = Sandbox.guestPath(args.optString("path"))
        val depth = args.optInt("depth", 2).coerceIn(1, 6)
        val script = """
            [ -d "${'$'}SD_PATH" ] || { echo "not a directory: ${'$'}SD_PATH"; exit 2; }
            cd -- "${'$'}SD_PATH" || exit 2
            { find . -mindepth 1 -maxdepth ${'$'}SD_DEPTH \( -name node_modules -o -name .git -o -name __pycache__ -o -name .venv \) -prune -o -type d -print | sed 's|${'$'}|/|'
              find . -mindepth 1 -maxdepth ${'$'}SD_DEPTH \( -name node_modules -o -name .git -o -name __pycache__ -o -name .venv \) -prune -o ! -type d -print
              find . -mindepth 1 -maxdepth ${'$'}SD_DEPTH \( -name node_modules -o -name .git -o -name __pycache__ -o -name .venv \) -prune -print 2>/dev/null | sed 's|${'$'}|/ (skipped)|'
            } | sed 's|^\./||' | sort | head -n 800
        """.trimIndent()
        val r = sandbox.exec(script, extraEnv = mapOf("SD_PATH" to path, "SD_DEPTH" to depth.toString()), timeoutSec = 60)
        if (r.exitCode != 0) return text(Sandbox.stripAnsi(r.output).trim(), isError = true)
        val body = r.output.trimEnd().ifEmpty { "(empty)" }
        return text("$path/\n$body")
    }

    private fun installPackages(args: JSONObject): JSONObject {
        val arr = args.optJSONArray("packages")
        val pkgs = when {
            arr != null -> List(arr.length()) { arr.optString(it).trim() }
            else -> args.optString("packages").split(Regex("[\\s,]+"))
        }.filter { it.isNotEmpty() }
        if (pkgs.isEmpty()) throw IllegalArgumentException("no packages given")
        val bad = pkgs.filterNot { PACKAGE_NAME.matches(it) }
        if (bad.isNotEmpty()) throw IllegalArgumentException("invalid package name(s): ${bad.joinToString()}")
        val list = pkgs.joinToString(" ") { "'$it'" }
        // The index is fetched on demand (and refreshed once if a package is not found).
        val cmd = "apk add $list 2>&1 || { apk update >/dev/null 2>&1; apk add $list; }"
        val r = sandbox.exec(cmd, timeoutSec = 900, announce = true)
        return text(formatExec("apk add ${pkgs.joinToString(" ")}", r), isError = r.exitCode != 0 && !r.killed)
    }

    private fun preview(args: JSONObject): JSONObject {
        val file = args.optString("file").trim()
        if (file.isNotEmpty()) {
            val guest = Sandbox.guestPath(file)
            val host = sandbox.hostFile(guest)
            if (host == null || !host.exists()) return text("$guest does not exist in the sandbox.", isError = true)
            val url = StudioPreview.urlFor(guest, isDir = host.isDirectory)
            return if (openPreview(url)) text("Opened $guest in the preview window for the user.")
            else text("$guest exists, but the preview window could not be opened right now (the app is in the background).", isError = true)
        }
        val port = args.optInt("port", 0)
        if (port !in 1..65535) throw IllegalArgumentException("give port (1-65535) for a server, or file for a file in the sandbox")
        val listening = runCatching {
            Socket().use { it.connect(InetSocketAddress("127.0.0.1", port), 1500) }
            true
        }.getOrDefault(false)
        if (!listening) {
            return text("Nothing is listening on 127.0.0.1:$port. Start the server first with run(background=true) and make sure it binds to 0.0.0.0 or 127.0.0.1.", isError = true)
        }
        val path = args.optString("path").trim().let { if (it.isEmpty()) "/" else if (it.startsWith("/")) it else "/$it" }
        val url = "http://127.0.0.1:$port$path"
        return if (openPreview(url)) text("Opened $url in the preview window for the user.")
        else text("The server is up at $url, but the preview window could not be opened right now.", isError = true)
    }

    private fun exportFile(args: JSONObject): JSONObject {
        val path = Sandbox.guestPath(required(args, "path"))
        val saved = sandbox.exportToDownloads(path, args.optString("name").takeIf { it.isNotBlank() })
        return text("Saved $path to the phone's Downloads folder as \"$saved\".")
    }

    private fun status(): JSONObject {
        val s = sandbox.status()
        val jobs = sandbox.listJobs()
        return text(buildString {
            append("Linux sandbox: ")
            when {
                !s.optBoolean("supported") -> append("unavailable — ").append(s.optString("reason"))
                !s.optBoolean("installed") -> append("not set up yet (it is downloaded automatically on first use, ~4 MB)")
                else -> {
                    append("${s.optString("distro")} ${s.optString("version")} (${s.optString("abi")})")
                    // A real round trip, so "ready" means commands actually run.
                    val probe = runCatching { sandbox.exec("uname -srm", timeoutSec = 30, maxOutput = 4000) }
                    val r = probe.getOrNull()
                    when {
                        r == null -> append(", NOT WORKING — ").append(probe.exceptionOrNull()?.message ?: "error")
                        r.exitCode == 0 -> append(", working (kernel ").append(r.output.trim().take(120)).append(")")
                        else -> append(", NOT WORKING — ").append(Sandbox.stripAnsi(r.output).trim().take(600))
                    }
                }
            }
            append("\nWorkspace: ${Sandbox.WORKSPACE}")
            val free = s.optLong("freeBytes", -1)
            if (free >= 0) append("\nFree space: ${free / (1024 * 1024)} MB")
            append("\nBackground jobs: ")
            if (jobs.isEmpty()) append("none")
            else jobs.forEach { append("\n  ${it.id} ${if (it.isRunning) "running" else "exited ${it.exitCode}"} $ ${it.command.take(100)}") }
        })
    }
}
