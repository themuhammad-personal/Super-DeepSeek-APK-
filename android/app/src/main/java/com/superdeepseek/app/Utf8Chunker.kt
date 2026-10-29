package com.superdeepseek.app

/**
 * Decodes a UTF-8 byte stream that arrives in arbitrary chunks: a multi-byte
 * character split between two reads is held back and completed by the next
 * chunk instead of becoming two replacement characters (Bengali, emoji…).
 * Invalid bytes still decode to U+FFFD. Not thread-safe; one per stream.
 */
internal class Utf8Chunker {
    private val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(java.nio.charset.CodingErrorAction.REPLACE)
            .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPLACE)
    private var carry = ByteArray(0)

    fun decode(buf: ByteArray, n: Int): String {
        val input = java.nio.ByteBuffer.allocate(carry.size + n)
        input.put(carry).put(buf, 0, n).flip()
        val out = java.nio.CharBuffer.allocate(input.remaining() + 2)
        decoder.decode(input, out, false)
        carry = ByteArray(input.remaining()).also { input.get(it) }
        out.flip()
        return out.toString()
    }
}
