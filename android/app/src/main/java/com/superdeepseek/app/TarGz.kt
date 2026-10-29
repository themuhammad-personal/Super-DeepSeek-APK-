package com.superdeepseek.app

import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.attribute.BasicFileAttributes
import java.util.zip.GZIPInputStream

/**
 * Minimal, safe extractor for `.tar.gz` root filesystems (Alpine minirootfs).
 *
 * Handles regular files, directories, symlinks, hard links (copied: app
 * storage does not allow hard links), GNU long names and PAX path headers.
 * Every entry must stay inside the destination: an entry whose path runs
 * through a symlink that leaves it is skipped (checked before any directory
 * is created along it), so a hostile archive cannot touch the rest of the
 * app's storage.
 *
 * Platform calls (symlink, chmod) are injected so the parser is testable on a
 * plain JVM.
 */
internal class TarGzExtractor(
        private val symlink: (target: String, link: File) -> Unit,
        private val chmod: (file: File, mode: Int) -> Unit,
        private val isSymlink: (file: File) -> Boolean = { Files.isSymbolicLink(it.toPath()) },
) {

    class Stats(var files: Int = 0, var dirs: Int = 0, var links: Int = 0, var bytes: Long = 0, var skipped: Int = 0)

    fun extract(input: InputStream, dest: File, onEntry: ((name: String) -> Unit)? = null): Stats {
        dest.mkdirs()
        val root = dest.canonicalFile
        val stats = Stats()
        val tar = GZIPInputStream(input.buffered(64 * 1024), 64 * 1024)
        val header = ByteArray(512)
        var longName: String? = null
        var longLink: String? = null
        var paxPath: String? = null
        var paxLink: String? = null
        val dirModes = ArrayList<Pair<File, Int>>()

        while (true) {
            if (!readBlock(tar, header)) break
            if (header.all { it.toInt() == 0 }) break // end-of-archive marker

            val type = header[156].toInt().toChar()
            val size = parseOctal(header, 124, 12)
            val mode = parseOctal(header, 100, 8).toInt()

            when (type) {
                'L' -> { longName = readString(tar, size); continue }
                'K' -> { longLink = readString(tar, size); continue }
                'x' -> {
                    val pax = parsePax(readString(tar, size))
                    paxPath = pax["path"] ?: paxPath
                    paxLink = pax["linkpath"] ?: paxLink
                    continue
                }
                'g' -> { skipEntry(tar, size); continue }
            }
            val rawName = longName ?: paxPath ?: headerName(header)
            val rawLink = longLink ?: paxLink ?: cString(header, 157, 100)
            longName = null; longLink = null; paxPath = null; paxLink = null

            val rel = safeRelative(rawName)
            if (rel == null) {
                skipEntry(tar, size)
                continue
            }
            val out = File(root, rel)
            val parent = out.parentFile ?: root
            if (!existingAncestorInside(root, parent)) {
                stats.skipped++
                skipEntry(tar, size)
                continue
            }
            onEntry?.invoke(rel)
            when (type) {
                '5' -> {
                    if (isSymlink(out)) out.delete()
                    out.mkdirs()
                    dirModes.add(out to mode)
                    stats.dirs++
                    skipEntry(tar, size)
                }
                '2' -> {
                    parent.mkdirs()
                    if (isSymlink(out) || out.isFile) out.delete()
                    if (!out.exists()) symlink(rawLink, out)
                    stats.links++
                    skipEntry(tar, size)
                }
                '1' -> {
                    parent.mkdirs()
                    val src = safeRelative(rawLink)?.let { File(root, it) }
                    if (src != null && src.isFile && isInside(root, src)) {
                        if (isSymlink(out)) out.delete()
                        src.copyTo(out, overwrite = true)
                        chmod(out, mode and 0xFFF)
                    }
                    stats.links++
                    skipEntry(tar, size)
                }
                '0', '\u0000', '7' -> {
                    parent.mkdirs()
                    if (isSymlink(out)) out.delete()
                    out.outputStream().use { sink -> copyExactly(tar, sink, size) }
                    skipPadding(tar, size)
                    chmod(out, mode and 0xFFF)
                    stats.files++
                    stats.bytes += size
                }
                else -> skipEntry(tar, size) // devices and fifos are not needed in a rootfs
            }
        }
        // Directory modes last (deepest first): a read-only directory must not
        // block its own children, and the owner always keeps rwx.
        for ((dir, mode) in dirModes.asReversed()) chmod(dir, (mode and 0xFFF) or 0x1C0)
        return stats
    }

    companion object {
        /** Archive path → a safe relative path, or null when it would escape the root. */
        internal fun safeRelative(name: String): String? {
            val parts = ArrayList<String>()
            for (p in name.replace('\\', '/').split('/')) {
                when (p) {
                    "", "." -> {}
                    ".." -> {
                        if (parts.isEmpty()) return null
                        parts.removeAt(parts.size - 1)
                    }
                    else -> parts.add(p)
                }
            }
            return if (parts.isEmpty()) null else parts.joinToString("/")
        }

        internal fun parseOctal(buf: ByteArray, off: Int, len: Int): Long {
            // GNU base-256 for large values.
            if (buf[off].toInt() and 0x80 != 0) {
                var v = 0L
                for (i in 1 until len) v = (v shl 8) or (buf[off + i].toLong() and 0xFF)
                return v
            }
            var v = 0L
            var i = off
            val end = off + len
            while (i < end && (buf[i] == ' '.code.toByte() || buf[i] == 0.toByte())) i++
            while (i < end) {
                val c = buf[i].toInt()
                if (c < '0'.code || c > '7'.code) break
                v = v * 8 + (c - '0'.code)
                i++
            }
            return v
        }

        internal fun cString(buf: ByteArray, off: Int, len: Int): String {
            var end = off
            while (end < off + len && buf[end].toInt() != 0) end++
            return String(buf, off, end - off, Charsets.UTF_8)
        }

        private fun headerName(h: ByteArray): String {
            val name = cString(h, 0, 100)
            val magic = cString(h, 257, 6)
            if (magic.startsWith("ustar")) {
                val prefix = cString(h, 345, 155)
                if (prefix.isNotEmpty()) return "$prefix/$name"
            }
            return name
        }

        /** PAX records: "<len> key=value\n". */
        internal fun parsePax(text: String): Map<String, String> {
            val out = HashMap<String, String>()
            for (line in text.split('\n')) {
                val sp = line.indexOf(' ')
                if (sp < 0) continue
                val kv = line.substring(sp + 1)
                val eq = kv.indexOf('=')
                if (eq <= 0) continue
                out[kv.substring(0, eq)] = kv.substring(eq + 1)
            }
            return out
        }

        private fun isInside(root: File, f: File): Boolean {
            val c = f.canonicalPath
            return c == root.path || c.startsWith(root.path + File.separator)
        }

        /** The deepest existing ancestor of [dir] (itself included) resolves inside [root]. */
        private fun existingAncestorInside(root: File, dir: File): Boolean {
            var d: File? = dir
            while (d != null && !d.exists()) d = d.parentFile
            return d != null && isInside(root, d)
        }

        private fun readBlock(input: InputStream, buf: ByteArray): Boolean {
            var read = 0
            while (read < buf.size) {
                val n = input.read(buf, read, buf.size - read)
                if (n < 0) return if (read == 0) false else throw IOException("truncated tar header")
                read += n
            }
            return true
        }

        private fun readString(input: InputStream, size: Long): String {
            if (size > 1024 * 1024) throw IOException("tar metadata entry too large")
            val bytes = ByteArray(size.toInt())
            var read = 0
            while (read < bytes.size) {
                val n = input.read(bytes, read, bytes.size - read)
                if (n < 0) throw IOException("truncated tar entry")
                read += n
            }
            skipPadding(input, size)
            return String(bytes, Charsets.UTF_8).trimEnd('\u0000', '\n')
        }

        private fun copyExactly(input: InputStream, out: OutputStream, size: Long) {
            val buf = ByteArray(64 * 1024)
            var left = size
            while (left > 0) {
                val n = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
                if (n < 0) throw IOException("truncated tar entry")
                out.write(buf, 0, n)
                left -= n
            }
        }

        private fun skipFully(input: InputStream, count: Long) {
            var left = count
            val buf = ByteArray(8192)
            while (left > 0) {
                val n = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
                if (n < 0) throw IOException("truncated tar entry")
                left -= n
            }
        }

        private fun skipPadding(input: InputStream, size: Long) {
            val pad = (512 - (size % 512)) % 512
            if (pad > 0) skipFully(input, pad)
        }

        private fun skipEntry(input: InputStream, size: Long) {
            if (size > 0) {
                skipFully(input, size)
                skipPadding(input, size)
            }
        }
    }
}

/**
 * Deletes [root] and everything below it WITHOUT following symlinks.
 *
 * Never use Kotlin's File.deleteRecursively() on a Linux root filesystem: it
 * follows symlinked directories, and a rootfs contains links such as
 * `-> /` or `-> /proc`, so it would walk out and delete whatever the app can
 * reach. Files.walkFileTree does not follow links by default; a link is
 * removed as a link.
 */
internal fun deleteTreeNoFollow(root: File): Boolean {
    val path = root.toPath()
    if (!Files.exists(path, java.nio.file.LinkOption.NOFOLLOW_LINKS)) return true
    if (Files.isSymbolicLink(path)) return runCatching { Files.delete(path) }.isSuccess
    return try {
        Files.walkFileTree(path, object : SimpleFileVisitor<Path>() {
            override fun preVisitDirectory(dir: Path, attrs: BasicFileAttributes): FileVisitResult {
                // Read-only directories (0555) would block deleting their children.
                dir.toFile().setWritable(true, true)
                dir.toFile().setExecutable(true, true)
                return FileVisitResult.CONTINUE
            }

            override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                Files.deleteIfExists(file)
                return FileVisitResult.CONTINUE
            }

            override fun visitFileFailed(file: Path, exc: IOException): FileVisitResult {
                runCatching { Files.deleteIfExists(file) }
                return FileVisitResult.CONTINUE
            }

            override fun postVisitDirectory(dir: Path, exc: IOException?): FileVisitResult {
                Files.deleteIfExists(dir)
                return FileVisitResult.CONTINUE
            }
        })
        true
    } catch (e: IOException) {
        false
    }
}
