package com.superdeepseek.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ShellProtocolTest {

    private val m = ShellProtocol.MARK

    private fun textOf(events: List<ShellProtocol.Event>) =
            events.filterIsInstance<ShellProtocol.Event.Text>().joinToString("") { it.text }

    @Test
    fun `a command is wrapped so the shell reports its end`() {
        // What busybox ash receives; verified against it: the braces make the
        // marker part of the command, not stdin of a program that reads it.
        assertEquals("{ ls -la\n} ; printf '\\036SD:%s:%s\\036\\n' \"\$?\" \"\$PWD\"\n", ShellProtocol.wrap("ls -la"))
    }

    @Test
    fun `the marker becomes a done event with exit code and folder`() {
        val p = ShellProtocol.Parser()
        val ev = p.feed("ls: cannot access 'x'\n${m}SD:2:/tmp${m}\n")
        assertEquals(listOf(ShellProtocol.Event.Text("ls: cannot access 'x'\n"), ShellProtocol.Event.Done(2, "/tmp")), ev)
    }

    @Test
    fun `markers split across reads are put back together`() {
        val whole = "out\n${m}SD:0:/root/workspace/my app${m}\nmore"
        for (cut in 1 until whole.length) {
            val p = ShellProtocol.Parser()
            val ev = p.feed(whole.substring(0, cut)) + p.feed(whole.substring(cut))
            assertEquals("cut at $cut", "out\nmore", textOf(ev))
            assertEquals("cut at $cut", listOf(ShellProtocol.Event.Done(0, "/root/workspace/my app")),
                    ev.filterIsInstance<ShellProtocol.Event.Done>())
        }
    }

    @Test
    fun `output without a final newline is noticed`() {
        val p = ShellProtocol.Parser()
        val ev = p.feed("abc${m}SD:0:/tmp${m}\n")
        assertEquals("abc", textOf(ev))
        assertFalse(p.atLineStart)
        p.feed("line\n")
        assertTrue(p.atLineStart)
    }

    @Test
    fun `separators that are not ours stay text`() {
        val p = ShellProtocol.Parser()
        assertEquals("a b c", textOf(p.feed("a ${m}b${m} c")))
        assertEquals(emptyList<ShellProtocol.Event>(), p.feed("${m}SD:x:/tmp").filterIsInstance<ShellProtocol.Event.Done>())
    }

    @Test
    fun `a runaway separator does not swallow the output`() {
        val p = ShellProtocol.Parser()
        val big = "x".repeat(5000)
        assertEquals("${m}SD:$big", textOf(p.feed("${m}SD:$big")))
    }

    @Test
    fun `shell start-up noise is dropped`() {
        assertEquals("hello\n", ShellProtocol.stripNoise("sh: can't access tty; job control turned off\nhello\n"))
        assertEquals("plain text\n", ShellProtocol.stripNoise("plain text\n"))
    }
}
