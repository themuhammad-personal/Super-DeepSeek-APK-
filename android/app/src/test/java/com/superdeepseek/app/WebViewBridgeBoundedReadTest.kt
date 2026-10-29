package com.superdeepseek.app

import android.net.Uri
import java.io.InputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows

@RunWith(RobolectricTestRunner::class)
class WebViewBridgeBoundedReadTest {

    @Test
    fun `readBoundedBytes returns full content under the cap`() {
        val result = readBoundedBytes("hello".byteInputStream(), 10)

        assertFalse(result.overflowed)
        assertArrayEquals("hello".toByteArray(), result.bytes)
    }

    @Test
    fun `readBoundedBytes signals overflow past the cap without reading further`() {
        val stream = CountingInputStream(ByteArray(20) { it.toByte() })

        val result = readBoundedBytes(stream, 5)

        assertTrue(result.overflowed)
        assertEquals(5, result.bytes.size)
        assertTrue(stream.bytesRead <= 6)
    }

    @Test
    fun `readPickedContentUri skips size-less oversized streams as too-large`() {
        val context = RuntimeEnvironment.getApplication()
        val bridge = WebViewBridge(context)
        val uri = Uri.parse("content://com.oem.files/document/primary%3ADocuments%2Fhuge.md")
        // Streamed text shares the 100 MB ceiling with binaries (2.70); generated lazily, never allocated.
        Shadows.shadowOf(context.contentResolver).registerInputStreamSupplier(uri) {
            RepeatingInputStream(WebViewBridge.MAX_PICKED_BLOB_SIZE + 1)
        }

        val result = bridge.readPickedContentUri(uri)

        assertTrue(result is PickedItemResult.Skipped)
        val skipped = result as PickedItemResult.Skipped
        assertEquals("huge.md", skipped.name)
        assertEquals("too-large", skipped.reason)
    }

    private class RepeatingInputStream(private val total: Long) : InputStream() {
        private var pos = 0L
        override fun read(): Int = if (pos >= total) -1 else { pos++; 'x'.code }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (pos >= total) return -1
            val n = minOf(len.toLong(), total - pos).toInt()
            java.util.Arrays.fill(b, off, off + n, 'x'.code.toByte())
            pos += n
            return n
        }
    }

    private class CountingInputStream(private val bytes: ByteArray) : InputStream() {
        var bytesRead = 0
            private set

        private var index = 0

        override fun read(): Int {
            if (index >= bytes.size) return -1
            bytesRead += 1
            return bytes[index++].toInt() and 0xff
        }
    }
}
