package com.superdeepseek.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SandboxToolsTest {

    @Test
    fun `edit replaces exactly one occurrence`() {
        val r = SandboxTools.applyEdit("a\nb\nc\n", "b", "B", all = false).getOrThrow()
        assertEquals("a\nB\nc\n", r.first)
        assertEquals(1, r.second)
    }

    @Test
    fun `edit refuses ambiguous or missing snippets`() {
        assertTrue(SandboxTools.applyEdit("x x", "x", "y", all = false).exceptionOrNull()!!.message!!.contains("2 times"))
        assertTrue(SandboxTools.applyEdit("abc", "zzz", "y", all = false).isFailure)
        assertTrue(SandboxTools.applyEdit("abc", "", "y", all = false).isFailure)
        assertEquals("y y", SandboxTools.applyEdit("x x", "x", "y", all = true).getOrThrow().first)
    }

    @Test
    fun `a CRLF replacement snippet is not doubled into CR CR LF`() {
        val r = SandboxTools.applyEdit("a\r\nb\r\n", "a\nb", "c\r\nd", all = false).getOrThrow()
        assertEquals("c\r\nd\r\n", r.first)
        assertEquals("x\r\ny\r\n", SandboxTools.toCrlf("x\ny\r\n"))
    }

    @Test
    fun `edit tolerates CRLF files`() {
        val r = SandboxTools.applyEdit("a\r\nb\r\n", "a\nb", "c\nd", all = false).getOrThrow()
        assertEquals("c\r\nd\r\n", r.first)
    }

    @Test
    fun `read window numbers lines and says how to continue`() {
        val w = SandboxTools.window("l1\nl2\nl3\n", 2, 1)
        assertTrue(w.startsWith("2  l2\n"))
        assertTrue(w.contains("offset_line=3"))
        assertEquals("[empty file]\n", SandboxTools.window("", 1, 10))
        assertTrue(SandboxTools.window("a\nb", 1, 10).contains("2  b"))
    }

    @Test
    fun `ansi codes and carriage-return progress are stripped`() {
        val s = Sandbox.stripAnsi("\u001B[32mgreen\u001B[0m ok\r\nprogress 10%\rprogress 100%\n\u001B]0;title\u0007done")
        assertEquals("green ok\nprogress 100%\ndone", s)
    }

    @Test
    fun `guest paths are relative to the workspace`() {
        assertEquals("/root/workspace/src/a.py", Sandbox.guestPath("src/a.py"))
        assertEquals("/etc/hosts", Sandbox.guestPath("/etc/hosts"))
        assertEquals("/root/x", Sandbox.guestPath("~/x"))
        assertEquals(Sandbox.WORKSPACE, Sandbox.guestPath(null))
        assertEquals(Sandbox.WORKSPACE, Sandbox.guestPath(" . "))
    }

    @Test
    fun `output keeps head and tail`() {
        val c = Sandbox.OutputCollector(10)
        val b = "0123456789ABCDEFGHIJ".toByteArray()
        c.write(b, b.size)
        val text = c.text()
        assertTrue(text.startsWith("01234"))
        assertTrue(text.endsWith("FGHIJ"))
        assertTrue(text.contains("10 bytes of output omitted"))
        val small = Sandbox.OutputCollector(100)
        small.write("hi".toByteArray(), 2)
        assertEquals("hi", small.text())
    }

    @Test
    fun `abi and server helpers`() {
        assertEquals("arm64-v8a", Sandbox.abiForLibDir("arm64"))
        assertEquals("armeabi-v7a", Sandbox.abiForLibDir("arm"))
        assertEquals("aarch64", Sandbox.alpineArch("arm64-v8a"))
        assertEquals("armv7", Sandbox.alpineArch("armeabi-v7a"))
        assertTrue(SandboxTools.isSandboxUrl("sandbox"))
        assertTrue(SandboxTools.isSandboxUrl("Sandbox://linux"))
        assertFalse(SandboxTools.isSandboxUrl("https://example.com/sandbox"))
        assertEquals("500ms", SandboxTools.formatDuration(500))
        assertEquals("12.3s", SandboxTools.formatDuration(12345))
        assertEquals("2m 5s", SandboxTools.formatDuration(125000))
    }

    @Test
    fun `minElfLoadAlign detects 4 KB versus 16 KB PT_LOAD alignment for Android 15 page-size checks`() {
        fun fakeElf64(align: Long): ByteArray {
            val bytes = ByteArray(128)
            val buf = java.nio.ByteBuffer.wrap(bytes).order(java.nio.ByteOrder.LITTLE_ENDIAN)
            bytes[0] = 0x7f.toByte(); bytes[1] = 'E'.code.toByte(); bytes[2] = 'L'.code.toByte(); bytes[3] = 'F'.code.toByte()
            bytes[4] = 2 // ELFCLASS64
            bytes[5] = 1 // ELFDATA2LSB
            buf.putLong(32, 64L)           // e_phoff
            buf.putShort(54, 56.toShort()) // e_phentsize
            buf.putShort(56, 1.toShort())  // e_phnum
            buf.putInt(64, 1)              // PT_LOAD
            buf.putLong(64 + 48, align)    // p_align
            return bytes
        }
        val elf4k = fakeElf64(0x1000L)
        val elf16k = fakeElf64(0x4000L)
        assertEquals(4096L, Sandbox.minElfLoadAlign(elf4k))
        assertEquals(16384L, Sandbox.minElfLoadAlign(elf16k))
        assertTrue(Sandbox.isElfAlignedForPageSize(elf4k, 4096L))
        assertFalse(Sandbox.isElfAlignedForPageSize(elf4k, 16384L))
        assertTrue(Sandbox.isElfAlignedForPageSize(elf16k, 16384L))
    }
}
