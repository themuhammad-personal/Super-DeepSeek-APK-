package com.superdeepseek.app

import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.util.zip.GZIPOutputStream
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class TarGzExtractorTest {

    private lateinit var work: File
    private lateinit var sentinel: File

    private val extractor = TarGzExtractor(
        symlink = { target, link -> Files.createSymbolicLink(link.toPath(), File(target).toPath()) },
        chmod = { f, mode ->
            f.setReadable(true, true)
            f.setWritable(mode and 0x80 != 0, true)
            f.setExecutable(mode and 0x40 != 0, true)
        },
    )

    @Before
    fun setUp() {
        work = Files.createTempDirectory("targz").toFile()
        sentinel = File(work, "sentinel").apply { mkdirs() }
        File(sentinel, "keep.txt").writeText("keep")
    }

    @After
    fun tearDown() {
        // Never File.deleteRecursively() here: the extracted tree has symlinks.
        deleteTreeNoFollow(work)
    }

    /** A tiny ustar writer, enough for these tests. */
    private class Tar {
        val out = ByteArrayOutputStream()

        fun entry(name: String, type: Char, data: ByteArray = ByteArray(0), link: String = "", mode: Int = 420) {
            val h = ByteArray(512)
            fun put(s: String, off: Int, len: Int) {
                val b = s.toByteArray()
                System.arraycopy(b, 0, h, off, minOf(b.size, len))
            }
            fun octal(v: Long, off: Int, len: Int) = put(java.lang.Long.toOctalString(v).padStart(len - 1, '0'), off, len - 1)
            put(name, 0, 100)
            octal(mode.toLong(), 100, 8)
            octal(0, 108, 8); octal(0, 116, 8)
            octal(data.size.toLong(), 124, 12)
            octal(0, 136, 12)
            h[156] = type.code.toByte()
            put(link, 157, 100)
            put("ustar", 257, 6); put("00", 263, 2)
            for (i in 148 until 156) h[i] = ' '.code.toByte()
            val sum = h.sumOf { it.toInt() and 0xFF }
            put(java.lang.Integer.toOctalString(sum).padStart(6, '0') + "\u0000 ", 148, 8)
            out.write(h)
            out.write(data)
            val pad = (512 - data.size % 512) % 512
            out.write(ByteArray(pad))
        }

        fun gz(): ByteArray {
            out.write(ByteArray(1024))
            val z = ByteArrayOutputStream()
            GZIPOutputStream(z).use { it.write(out.toByteArray()) }
            return z.toByteArray()
        }
    }

    @Test
    fun `extracts files, dirs, symlinks, hard links and long names`() {
        val tar = Tar()
        tar.entry("./bin/", '5', mode = 493)
        tar.entry("./bin/busybox", '0', "ELF".toByteArray(), mode = 493)
        tar.entry("./bin/sh", '2', link = "/bin/busybox")
        tar.entry("./usr/bin/hard", '1', link = "./bin/busybox", mode = 493)
        val long = "d".repeat(120) + "/long.txt"
        tar.entry("././@LongLink", 'L', (long + "\u0000").toByteArray())
        tar.entry("ignored", '0', "long".toByteArray())
        val root = File(work, "root")

        val stats = extractor.extract(tar.gz().inputStream(), root)

        assertEquals(2, stats.files)
        assertEquals(2, stats.links)
        assertEquals("ELF", File(root, "bin/busybox").readText())
        assertTrue(File(root, "bin/busybox").canExecute())
        assertEquals("/bin/busybox", Files.readSymbolicLink(File(root, "bin/sh").toPath()).toString())
        assertEquals("ELF", File(root, "usr/bin/hard").readText())
        assertEquals("long", File(root, long).readText())
    }

    @Test
    fun `entries cannot escape the root`() {
        val tar = Tar()
        tar.entry("../evil", '0', "bad".toByteArray())
        tar.entry("./esc", '2', link = sentinel.path)
        tar.entry("./esc/owned", '0', "bad".toByteArray())
        tar.entry("./esc/sub/deep", '0', "bad".toByteArray())
        tar.entry("./after.txt", '0', "after".toByteArray())
        val root = File(work, "root")

        val stats = extractor.extract(tar.gz().inputStream(), root)

        assertEquals(2, stats.skipped)
        assertFalse(File(work, "evil").exists())
        assertFalse(File(sentinel, "owned").exists())
        assertFalse(File(sentinel, "sub").exists())
        assertEquals("after", File(root, "after.txt").readText())
    }

    @Test
    fun `deleteTreeNoFollow removes links, not their targets`() {
        val root = File(work, "root").apply { mkdirs() }
        Files.createSymbolicLink(File(root, "up").toPath(), sentinel.toPath())
        File(root, "ro").apply { mkdirs(); File(this, "f").writeText("x"); setWritable(false) }

        assertTrue(deleteTreeNoFollow(root))

        assertFalse(root.exists())
        assertEquals("keep", File(sentinel, "keep.txt").readText())
    }

    @Test
    fun `path and header helpers`() {
        assertNull(TarGzExtractor.safeRelative("a/../../b"))
        assertNull(TarGzExtractor.safeRelative("./"))
        assertEquals("x/y", TarGzExtractor.safeRelative("./x/./y/"))
        assertEquals("b", TarGzExtractor.safeRelative("/a/../b"))
        assertEquals(mapOf("path" to "a/b", "linkpath" to "c"), TarGzExtractor.parsePax("12 path=a/b\n14 linkpath=c\n"))
        val buf = "0000755\u0000".toByteArray()
        assertEquals(493L, TarGzExtractor.parseOctal(buf, 0, 8))
    }
}
