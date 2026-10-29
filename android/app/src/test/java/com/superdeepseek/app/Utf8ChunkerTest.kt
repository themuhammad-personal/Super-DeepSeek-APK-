package com.superdeepseek.app

import org.junit.Assert.assertEquals
import org.junit.Test

class Utf8ChunkerTest {

    private fun decodeInChunks(bytes: ByteArray, size: Int): String {
        val chunker = Utf8Chunker()
        val sb = StringBuilder()
        var i = 0
        while (i < bytes.size) {
            val n = minOf(size, bytes.size - i)
            sb.append(chunker.decode(bytes.copyOfRange(i, i + n), n))
            i += n
        }
        return sb.toString()
    }

    @Test
    fun `characters split across reads come out whole`() {
        val text = "বাংলা লেখা, العربية, 中文 and emoji 🚀✨ mixed with ASCII.\n"
        val bytes = text.toByteArray(Charsets.UTF_8)
        // Every chunk size, so every possible split point inside a character is hit.
        for (size in 1..9) assertEquals("chunk size $size", text, decodeInChunks(bytes, size))
    }

    @Test
    fun `only the first n bytes of the buffer are read`() {
        val chunker = Utf8Chunker()
        val buf = "abcXYZ".toByteArray(Charsets.UTF_8)
        assertEquals("abc", chunker.decode(buf, 3))
    }

    @Test
    fun `an incomplete character is held until the next chunk`() {
        val chunker = Utf8Chunker()
        val rocket = "🚀".toByteArray(Charsets.UTF_8) // 4 bytes
        assertEquals("", chunker.decode(rocket, 2))
        assertEquals("🚀!", chunker.decode(rocket.copyOfRange(2, 4) + '!'.code.toByte(), 3))
    }

    @Test
    fun `invalid bytes still become replacement characters`() {
        val chunker = Utf8Chunker()
        val bad = byteArrayOf('a'.code.toByte(), 0xFF.toByte(), 'b'.code.toByte())
        assertEquals("a\uFFFDb", chunker.decode(bad, bad.size))
    }
}
