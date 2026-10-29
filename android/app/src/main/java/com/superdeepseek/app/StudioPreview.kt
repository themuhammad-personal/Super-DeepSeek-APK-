package com.superdeepseek.app

/**
 * Files from the sandbox in Linux Studio's Preview (pure; no Android types,
 * so it is unit-tested on the JVM).
 *
 * A sandbox file is shown at https://workspace.invalid/<guest path>
 * (".invalid" never resolves, so nothing leaves the phone). Studio's preview
 * WebView answers those requests itself from the Linux file system. Relative
 * links, stylesheets, scripts and images of a page resolve like on a real web
 * server, and the page runs over https, so modern web APIs work.
 *
 * The URL path is only ever used as a guest path, normalised here (no "..")
 * and then confined to the Linux system by [Sandbox.hostFile].
 */
internal object StudioPreview {

    const val HOST = "workspace.invalid"
    const val ORIGIN = "https://$HOST"

    /** Query flag: the file itself instead of its viewer page (images, Markdown). */
    const val RAW = "raw"

    private val MIME = mapOf(
            "html" to "text/html", "htm" to "text/html", "xhtml" to "application/xhtml+xml",
            "css" to "text/css", "js" to "text/javascript", "mjs" to "text/javascript", "cjs" to "text/javascript",
            "json" to "application/json", "map" to "application/json", "webmanifest" to "application/manifest+json",
            "xml" to "application/xml", "txt" to "text/plain", "md" to "text/markdown", "markdown" to "text/markdown",
            "csv" to "text/csv", "svg" to "image/svg+xml", "png" to "image/png", "jpg" to "image/jpeg",
            "jpeg" to "image/jpeg", "gif" to "image/gif", "webp" to "image/webp", "avif" to "image/avif",
            "bmp" to "image/bmp", "ico" to "image/x-icon", "wasm" to "application/wasm", "woff" to "font/woff",
            "woff2" to "font/woff2", "ttf" to "font/ttf", "otf" to "font/otf", "mp4" to "video/mp4",
            "webm" to "video/webm", "ogg" to "audio/ogg", "mp3" to "audio/mpeg", "wav" to "audio/wav",
            "m4a" to "audio/mp4", "pdf" to "application/pdf")

    private val IMAGE = setOf("png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg")
    private val VIDEO = setOf("mp4", "webm")
    private val AUDIO = setOf("mp3", "wav", "ogg", "m4a")
    private val PAGE = setOf("html", "htm", "xhtml")
    private val MARKDOWN = setOf("md", "markdown")

    enum class Kind { PAGE, MARKDOWN, IMAGE, VIDEO, AUDIO, OTHER }

    fun extension(name: String): String = name.substringAfterLast('/').substringAfterLast('.', "").lowercase()

    fun kind(name: String): Kind = when (extension(name)) {
        in PAGE -> Kind.PAGE
        in MARKDOWN -> Kind.MARKDOWN
        in IMAGE -> Kind.IMAGE
        in VIDEO -> Kind.VIDEO
        in AUDIO -> Kind.AUDIO
        else -> Kind.OTHER
    }

    /** Files the Preview shows better than the text viewer does. */
    fun isPreviewable(name: String): Boolean = kind(name) != Kind.OTHER

    fun mimeOf(name: String): String = MIME[extension(name)] ?: "application/octet-stream"

    fun isText(mime: String): Boolean = mime.startsWith("text/") || mime == "application/json" ||
            mime == "application/xml" || mime == "image/svg+xml" || mime == "application/manifest+json" ||
            mime == "application/xhtml+xml"

    // ── URLs ─────────────────────────────────────────────────────────────────

    private const val HEX = "0123456789ABCDEF"

    private fun unreserved(b: Int): Boolean = (b in 'a'.code..'z'.code) || (b in 'A'.code..'Z'.code) ||
            (b in '0'.code..'9'.code) || b == '-'.code || b == '.'.code || b == '_'.code || b == '~'.code

    private fun encodeSegment(s: String): String {
        val out = StringBuilder()
        for (byte in s.toByteArray(Charsets.UTF_8)) {
            val b = byte.toInt() and 0xFF
            if (unreserved(b)) out.append(b.toChar())
            else out.append('%').append(HEX[b shr 4]).append(HEX[b and 15])
        }
        return out.toString()
    }

    /** Percent-decoding for paths ('+' stays a plus). Null when malformed. */
    fun decodePath(s: String): String? {
        val bytes = java.io.ByteArrayOutputStream()
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '%') {
                if (i + 2 >= s.length) return null
                val hi = Character.digit(s[i + 1], 16)
                val lo = Character.digit(s[i + 2], 16)
                if (hi < 0 || lo < 0) return null
                bytes.write(hi * 16 + lo)
                i += 3
            } else {
                bytes.write(c.toString().toByteArray(Charsets.UTF_8))
                i++
            }
        }
        return bytes.toString("UTF-8")
    }

    /**
     * An absolute guest path without "." / ".." / empty segments; null when
     * it would climb above "/" or contains a NUL.
     */
    fun normalize(path: String): String? {
        if (!path.startsWith("/") || path.indexOf('\u0000') >= 0) return null
        val parts = ArrayList<String>()
        for (seg in path.split('/')) {
            when (seg) {
                "", "." -> {}
                ".." -> { if (parts.isEmpty()) return null; parts.removeAt(parts.size - 1) }
                else -> parts.add(seg)
            }
        }
        return "/" + parts.joinToString("/")
    }

    /** The preview URL of a guest path (a folder gets a trailing slash). */
    fun urlFor(guestPath: String, isDir: Boolean = false): String {
        val norm = normalize(guestPath) ?: "/"
        val enc = norm.split('/').joinToString("/") { encodeSegment(it) }
        return ORIGIN + enc + if (isDir && !enc.endsWith("/")) "/" else ""
    }

    /** The guest path behind a preview URL's (encoded) path, or null. */
    fun guestPathOf(encodedPath: String?): String? {
        val decoded = decodePath(encodedPath?.ifEmpty { "/" } ?: "/") ?: return null
        return normalize(decoded)
    }

    fun isPreviewUrl(url: String?): Boolean = url != null && (url == ORIGIN || url.startsWith("$ORIGIN/"))

    /** What the address field shows: the guest path for files, the URL otherwise. */
    fun displayOf(url: String): String {
        if (!isPreviewUrl(url)) return url
        val path = url.removePrefix(ORIGIN).substringBefore('?').substringBefore('#')
        return guestPathOf(path) ?: url
    }

    // ── Pages ────────────────────────────────────────────────────────────────

    fun escapeHtml(s: String): String {
        val out = StringBuilder(s.length + 16)
        for (c in s) when (c) {
            '&' -> out.append("&amp;")
            '<' -> out.append("&lt;")
            '>' -> out.append("&gt;")
            '"' -> out.append("&quot;")
            '\'' -> out.append("&#39;")
            else -> out.append(c)
        }
        return out.toString()
    }

    private fun page(title: String, dark: Boolean, css: String, body: String): String {
        val bg = if (dark) "#1e1f23" else "#ffffff"
        val fg = if (dark) "#ececf1" else "#1f1f23"
        val muted = if (dark) "#9a9ba6" else "#6b6c75"
        val line = if (dark) "#34353b" else "#e6e6ea"
        val surface = if (dark) "#2a2b31" else "#f3f4f6"
        val accent = if (dark) "#8ab4ff" else "#3957e0"
        return """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="${if (dark) "dark" else "light"}">
<title>${escapeHtml(title)}</title><style>
:root{--bg:$bg;--fg:$fg;--muted:$muted;--line:$line;--surface:$surface;--accent:$accent}
html,body{margin:0;background:var(--bg);color:var(--fg)}
body{font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
a{color:var(--accent)}
$css
</style></head><body>$body</body></html>"""
    }

    /** A picture, video or sound file centred on the Studio background. */
    fun mediaPage(name: String, kind: Kind, dark: Boolean): String {
        val src = escapeHtml(encodeSegment(name)) + "?$RAW=1"
        val el = when (kind) {
            Kind.VIDEO -> """<video src="$src" controls playsinline></video>"""
            Kind.AUDIO -> """<audio src="$src" controls></audio>"""
            else -> """<img src="$src" alt="${escapeHtml(name)}">"""
        }
        val checker = if (dark) "#26272c" else "#eceef1"
        return page(name, dark,
                "body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}" +
                        "img,video{max-width:100%;max-height:calc(100vh - 32px);object-fit:contain;border-radius:8px;" +
                        "background:repeating-conic-gradient($checker 0% 25%,transparent 0% 50%) 50%/20px 20px}" +
                        "audio{width:100%;max-width:520px}",
                el)
    }

    /** A folder without index.html: its entries (folders first). */
    fun listingPage(guestPath: String, entries: List<Pair<String, Boolean>>, dark: Boolean, emptyNote: String = "Empty folder"): String {
        val rows = StringBuilder()
        if (guestPath != "/") rows.append("""<a class="e d" href="../">..</a>""")
        entries.sortedWith(compareBy<Pair<String, Boolean>>({ !it.second }, { it.first.lowercase() })).forEach { (name, dir) ->
            val href = escapeHtml(encodeSegment(name)) + if (dir) "/" else ""
            rows.append("""<a class="e${if (dir) " d" else ""}" href="$href">${escapeHtml(name)}${if (dir) "/" else ""}</a>""")
        }
        if (entries.isEmpty()) rows.append("""<p class="m">${escapeHtml(emptyNote)}</p>""")
        return page(guestPath, dark,
                "main{max-width:760px;margin:0 auto;padding:16px}h1{font-size:15px;font-weight:600;color:var(--muted);" +
                        "font-family:ui-monospace,monospace;word-break:break-all;margin:4px 0 12px}" +
                        ".e{display:block;padding:11px 12px;border-bottom:1px solid var(--line);text-decoration:none;color:var(--fg);" +
                        "font-family:ui-monospace,monospace;font-size:14px;word-break:break-all}.d{color:var(--accent);font-weight:600}.m{color:var(--muted)}",
                "<main><h1>${escapeHtml(guestPath)}</h1>$rows</main>")
    }

    /** A folder URL typed without its trailing slash: continue at the right URL. */
    fun redirectPage(to: String): String =
            """<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${escapeHtml(to)}">""" +
                    """<script>location.replace(${jsString(to)})</script>"""

    private fun jsString(s: String): String = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"")
            .replace("<", "\\u003c").replace("\n", "\\n") + "\""

    fun markdownPage(name: String, markdown: String, dark: Boolean): String = page(name, dark,
            "main{max-width:760px;margin:0 auto;padding:12px 18px 40px;overflow-wrap:anywhere}" +
                    "h1,h2{border-bottom:1px solid var(--line);padding-bottom:.3em}h1{font-size:1.7em}h2{font-size:1.35em}" +
                    "h1,h2,h3,h4,h5,h6{line-height:1.3;margin:1.3em 0 .5em}" +
                    "code{font-family:ui-monospace,\"JetBrains Mono\",monospace;font-size:.88em;background:var(--surface);padding:.15em .35em;border-radius:5px}" +
                    "pre{background:var(--surface);padding:12px 14px;border-radius:10px;overflow:auto;line-height:1.45}pre code{background:none;padding:0}" +
                    "blockquote{margin:0;padding:0 1em;color:var(--muted);border-left:3px solid var(--line)}" +
                    "img{max-width:100%}hr{border:0;border-top:1px solid var(--line);margin:1.5em 0}" +
                    "table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid var(--line);padding:6px 10px}th{background:var(--surface)}" +
                    "li+li{margin-top:.2em}input[type=checkbox]{margin-right:.4em}",
            "<main>" + Markdown.toHtml(markdown) + "</main>")
}

/**
 * A small, safe Markdown renderer for the Preview: headings, paragraphs,
 * emphasis, code (inline and fenced), links, images, lists (nested, ordered,
 * task lists), quotes, tables and rules. Raw HTML is shown as text.
 */
internal object Markdown {

    private val FENCE = Regex("^\\s{0,3}(```+|~~~+)\\s*([^`\\s]*)?.*$")
    private val HEADING = Regex("^\\s{0,3}(#{1,6})\\s+(.*?)\\s*#*\\s*$")
    private val RULE = Regex("^\\s{0,3}([-*_])(\\s*\\1){2,}\\s*$")
    private val LIST_ITEM = Regex("^(\\s*)([-*+]|\\d{1,9}[.)])\\s+(.*)$")
    private val QUOTE = Regex("^\\s{0,3}>\\s?(.*)$")
    private val TABLE_SEP = Regex("^\\s*\\|?\\s*:?-{2,}:?\\s*(\\|\\s*:?-{2,}:?\\s*)*\\|?\\s*$")

    fun toHtml(md: String): String {
        val lines = md.replace("\r\n", "\n").replace('\r', '\n').split('\n')
        val out = StringBuilder()
        render(lines, out)
        return out.toString()
    }

    private fun render(lines: List<String>, out: StringBuilder) {
        var i = 0
        val para = ArrayList<String>()
        fun flushPara() {
            if (para.isNotEmpty()) {
                out.append("<p>").append(inline(para.joinToString("\n")).replace("\n", "<br>")).append("</p>\n")
                para.clear()
            }
        }
        while (i < lines.size) {
            val line = lines[i]
            val fence = FENCE.matchEntire(line)
            when {
                fence != null -> {
                    flushPara()
                    val marker = fence.groupValues[1]
                    val lang = fence.groupValues[2]
                    val code = StringBuilder()
                    i++
                    while (i < lines.size && !lines[i].trimStart().startsWith(marker)) {
                        code.append(lines[i]).append('\n'); i++
                    }
                    i++ // the closing fence
                    val cls = if (lang.isNotEmpty()) " class=\"language-${StudioPreview.escapeHtml(lang)}\"" else ""
                    out.append("<pre><code$cls>").append(StudioPreview.escapeHtml(code.toString().trimEnd('\n'))).append("</code></pre>\n")
                    continue
                }
                line.isBlank() -> flushPara()
                HEADING.matchEntire(line) != null -> {
                    flushPara()
                    val m = HEADING.matchEntire(line)!!
                    val n = m.groupValues[1].length
                    out.append("<h$n>").append(inline(m.groupValues[2])).append("</h$n>\n")
                }
                RULE.matches(line) -> { flushPara(); out.append("<hr>\n") }
                QUOTE.matchEntire(line) != null -> {
                    flushPara()
                    val inner = ArrayList<String>()
                    while (i < lines.size) {
                        val q = QUOTE.matchEntire(lines[i]) ?: break
                        inner.add(q.groupValues[1]); i++
                    }
                    out.append("<blockquote>\n")
                    render(inner, out)
                    out.append("</blockquote>\n")
                    continue
                }
                LIST_ITEM.matchEntire(line) != null -> {
                    flushPara()
                    i = list(lines, i, out)
                    continue
                }
                line.contains('|') && i + 1 < lines.size && TABLE_SEP.matches(lines[i + 1]) -> {
                    flushPara()
                    i = table(lines, i, out)
                    continue
                }
                else -> para.add(line.trim())
            }
            i++
        }
        flushPara()
    }

    private fun indentOf(s: String): Int {
        var n = 0
        for (c in s) { if (c == ' ') n++ else if (c == '\t') n += 4 else break }
        return n
    }

    /** A list starting at [start]; returns the index after it. */
    private fun list(lines: List<String>, start: Int, out: StringBuilder): Int {
        val first = LIST_ITEM.matchEntire(lines[start])!!
        val base = indentOf(first.groupValues[1])
        val ordered = first.groupValues[2].first().isDigit()
        val startNum = if (ordered) first.groupValues[2].dropLast(1).toIntOrNull() ?: 1 else 1
        out.append(if (ordered) (if (startNum != 1) "<ol start=\"$startNum\">\n" else "<ol>\n") else "<ul>\n")
        var i = start
        while (i < lines.size) {
            val m = LIST_ITEM.matchEntire(lines[i]) ?: break
            val ind = indentOf(m.groupValues[1])
            if (ind < base) break
            if (m.groupValues[2].first().isDigit() != ordered && ind == base) break
            // The item's own text plus continuation lines and nested lists.
            val body = ArrayList<String>()
            body.add(m.groupValues[3])
            i++
            while (i < lines.size) {
                val l = lines[i]
                if (l.isBlank()) {
                    val next = lines.getOrNull(i + 1)
                    if (next != null && indentOf(next) > base && next.isNotBlank()) { body.add(""); i++; continue }
                    break
                }
                val sub = LIST_ITEM.matchEntire(l)
                if (sub != null && indentOf(sub.groupValues[1]) <= base) break
                if (sub == null && indentOf(l) <= base && !isBlockStart(l)) {
                    // A lazy continuation line of the item's paragraph.
                    body.add(l.trim()); i++; continue
                }
                if (sub == null && indentOf(l) <= base) break
                body.add(l.substring(indentPrefixLen(l, base + 2)))
                i++
            }
            var text = body.first()
            var task = ""
            val t = Regex("^\\[([ xX])]\\s+(.*)$").matchEntire(text)
            if (t != null) {
                task = if (t.groupValues[1] == " ") "<input type=\"checkbox\" disabled> " else "<input type=\"checkbox\" checked disabled> "
                text = t.groupValues[2]
            }
            out.append("<li>").append(task).append(inline(text))
            val rest = body.drop(1)
            if (rest.any { it.isNotBlank() }) {
                out.append('\n')
                render(rest, out)
            }
            out.append("</li>\n")
        }
        out.append(if (ordered) "</ol>\n" else "</ul>\n")
        return i
    }

    private fun isBlockStart(l: String): Boolean = FENCE.matches(l) || HEADING.matches(l) || RULE.matches(l) || QUOTE.matches(l)

    /** Characters that make up the first [cols] columns of leading whitespace. */
    private fun indentPrefixLen(s: String, cols: Int): Int {
        var n = 0
        var i = 0
        while (i < s.length && n < cols) {
            when (s[i]) { ' ' -> n++; '\t' -> n += 4; else -> return i }
            i++
        }
        return i
    }

    private fun cells(row: String): List<String> {
        var r = row.trim()
        if (r.startsWith("|")) r = r.substring(1)
        if (r.endsWith("|") && !r.endsWith("\\|")) r = r.dropLast(1)
        return r.split(Regex("(?<!\\\\)\\|")).map { it.trim().replace("\\|", "|") }
    }

    private fun table(lines: List<String>, start: Int, out: StringBuilder): Int {
        val head = cells(lines[start])
        val aligns = cells(lines[start + 1]).map {
            when {
                it.startsWith(":") && it.endsWith(":") -> " style=\"text-align:center\""
                it.endsWith(":") -> " style=\"text-align:right\""
                else -> ""
            }
        }
        out.append("<table><thead><tr>")
        head.forEachIndexed { k, c -> out.append("<th${aligns.getOrElse(k) { "" }}>").append(inline(c)).append("</th>") }
        out.append("</tr></thead><tbody>\n")
        var i = start + 2
        while (i < lines.size && lines[i].contains('|') && lines[i].isNotBlank()) {
            out.append("<tr>")
            cells(lines[i]).forEachIndexed { k, c -> out.append("<td${aligns.getOrElse(k) { "" }}>").append(inline(c)).append("</td>") }
            out.append("</tr>\n")
            i++
        }
        out.append("</tbody></table>\n")
        return i
    }

    private val CODE_SPAN = Regex("(`+)(.+?)\\1")
    private val IMAGE = Regex("!\\[([^\\]]*)]\\(\\s*((?:[^()\\s]|\\([^()\\s]*\\))+)(?:\\s+&quot;([^&]*)&quot;)?\\s*\\)")
    private val LINK = Regex("\\[([^\\]]+)]\\(\\s*((?:[^()\\s]|\\([^()\\s]*\\))+)(?:\\s+&quot;([^&]*)&quot;)?\\s*\\)")
    private val AUTOLINK = Regex("&lt;(https?://[^\\s&]+)&gt;")
    private val BOLD = Regex("(\\*\\*|__)(?=\\S)(.+?)(?<=\\S)\\1")
    private val ITALIC = Regex("(?<![*\\w])([*_])(?=\\S)(.+?)(?<=\\S)\\1(?![*\\w])")
    private val STRIKE = Regex("~~(?=\\S)(.+?)(?<=\\S)~~")

    /** javascript:, data: (except images) and vbscript: links are dropped. */
    private fun safeUrl(u: String, image: Boolean): String {
        val l = u.trim().lowercase()
        if (l.startsWith("javascript:") || l.startsWith("vbscript:")) return "#"
        if (l.startsWith("data:") && !(image && l.startsWith("data:image/"))) return "#"
        return u
    }

    /** Inline Markdown over HTML-escaped text; code spans are kept literal. */
    fun inline(src: String): String {
        val codes = ArrayList<String>()
        var s = CODE_SPAN.replace(src) { m ->
            codes.add("<code>" + StudioPreview.escapeHtml(m.groupValues[2].trim()) + "</code>")
            "\u0000${codes.size - 1}\u0000"
        }
        s = StudioPreview.escapeHtml(s)
        // Attribute values wait in slots, so emphasis never reaches into a URL.
        val attrs = ArrayList<String>()
        fun slot(v: String): String { attrs.add(v); return "\u0001${attrs.size - 1}\u0001" }
        s = IMAGE.replace(s) { m ->
            val title = m.groupValues[3].takeIf { it.isNotEmpty() }?.let { " title=\"${slot(it)}\"" } ?: ""
            "<img src=\"${slot(safeUrl(m.groupValues[2], true))}\" alt=\"${slot(m.groupValues[1])}\"$title>"
        }
        s = LINK.replace(s) { m ->
            val title = m.groupValues[3].takeIf { it.isNotEmpty() }?.let { " title=\"${slot(it)}\"" } ?: ""
            "<a href=\"${slot(safeUrl(m.groupValues[2], false))}\"$title>${m.groupValues[1]}</a>"
        }
        s = AUTOLINK.replace(s) { m -> "<a href=\"${slot(m.groupValues[1])}\">${slot(m.groupValues[1])}</a>" }
        s = BOLD.replace(s) { m -> "<strong>${m.groupValues[2]}</strong>" }
        s = ITALIC.replace(s) { m -> "<em>${m.groupValues[2]}</em>" }
        s = STRIKE.replace(s) { m -> "<del>${m.groupValues[1]}</del>" }
        s = Regex("\u0001(\\d+)\u0001").replace(s) { m -> attrs[m.groupValues[1].toInt()] }
        return Regex("\u0000(\\d+)\u0000").replace(s) { m -> codes[m.groupValues[1].toInt()] }
    }
}
