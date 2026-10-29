package com.superdeepseek.app

import java.io.ByteArrayInputStream
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class NativeBlobStoreTest {

    @Test
    fun `registered bytes are served with no-store headers`() {
        val store = NativeBlobStore()
        val token = store.registerBytes("a b.txt", "text/plain", "hello".toByteArray())

        val response = store.serve(NativeBlobStore.PATH_PREFIX + token)

        assertNotNull(response)
        assertEquals(200, response!!.statusCode)
        assertEquals("text/plain", response.mimeType)
        assertEquals("no-store", response.responseHeaders["Cache-Control"])
        assertEquals("5", response.responseHeaders["X-SD-Size"])
        assertEquals("a%20b.txt", response.responseHeaders["X-SD-Name"])
        assertEquals("hello", response.data.readBytes().toString(Charsets.UTF_8))
    }

    @Test
    fun `tokens are random 32-hex and unknown ones are 404`() {
        val store = NativeBlobStore()
        val a = store.registerBytes("a", "", ByteArray(0))
        val b = store.registerBytes("b", "", ByteArray(0))
        assertTrue(a.matches(Regex("[0-9a-f]{32}")))
        assertFalse(a == b)
        assertEquals(404, store.serve(NativeBlobStore.PATH_PREFIX + "0".repeat(32))!!.statusCode)
        assertEquals("application/octet-stream", store.lookup(a)!!.mime)
    }

    @Test
    fun `paths that are not ours are left alone`() {
        val store = NativeBlobStore()
        assertNull(store.serve("/api/v0/chat"))
        assertNull(store.serve(null))
        assertNull(store.serve(NativeBlobStore.PATH_PREFIX + "../../etc/passwd"))
        assertNull(parseBlobToken(NativeBlobStore.PATH_PREFIX + "ABCDEF".padEnd(32, '0')))
    }

    @Test
    fun `entries expire`() {
        var now = 1_000L
        val store = NativeBlobStore(ttlMillis = 100, clock = { now })
        val token = store.registerBytes("a", "text/plain", ByteArray(1))
        now += 50
        assertNotNull(store.lookup(token))
        now += 100
        assertNull(store.lookup(token))
        assertEquals(404, store.serve(NativeBlobStore.PATH_PREFIX + token)!!.statusCode)
    }

    @Test
    fun `one-shot entries are served once`() {
        val store = NativeBlobStore()
        val token = store.registerBytes("r.json", "application/json", "{}".toByteArray(), oneShot = true)
        assertEquals(200, store.serve(NativeBlobStore.PATH_PREFIX + token)!!.statusCode)
        assertEquals(404, store.serve(NativeBlobStore.PATH_PREFIX + token)!!.statusCode)
    }

    @Test
    fun `a source that fails to open is a 404, not a crash`() {
        val store = NativeBlobStore()
        val token = store.register("x", "text/plain", 1) { throw SecurityException("revoked") }
        assertEquals(404, store.serve(NativeBlobStore.PATH_PREFIX + token)!!.statusCode)
    }

    @Test
    fun `text sniffing`() {
        assertTrue(looksLikeText("plain ascii\n".toByteArray()))
        assertTrue(looksLikeText("বাংলা লেখা".toByteArray()))
        assertFalse(looksLikeText(byteArrayOf(0x25, 0x50, 0x00, 0x46)))
        assertFalse(looksLikeText(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte())))
        // A multi-byte character cut by the sample boundary is still text.
        val bn = "অ".toByteArray()
        assertTrue(looksLikeText(bn, bn.size - 1))
        assertTrue(looksLikeText(ByteArray(0)))
    }

    @Test
    fun `countStreamBytes stops past the cap`() {
        assertEquals(10L, countStreamBytes(ByteArrayInputStream(ByteArray(10)), 100))
        assertTrue(countStreamBytes(ByteArrayInputStream(ByteArray(1_000_000)), 1000) > 1000)
    }

    @Test
    fun `bridge replies are inline when small and blobs when large`() {
        val store = NativeBlobStore()
        val small = buildBridgeReplyScript("f1_ab", "{\"ok\":true}", store)
        assertEquals("window.__sdBridgeReply&&window.__sdBridgeReply('f1_ab',${JSONObject.quote("{\"ok\":true}")},null);", small)
        assertEquals(0, store.size())

        val big = "x".repeat(ASYNC_REPLY_INLINE_CHARS + 1)
        val script = buildBridgeReplyScript("f2", big, store)
        assertEquals(1, store.size())
        val path = Regex("'(/__sd/blob/[0-9a-f]{32})'").find(script)!!.groupValues[1]
        assertEquals(big.length, store.serve(path)!!.data.readBytes().size)
    }

    @Test
    fun `callback ids cannot break out of the script`() {
        val script = buildBridgeReplyScript("a');alert(1);//", "{}", NativeBlobStore())
        assertFalse(script.contains("alert(1)"))
    }
}
