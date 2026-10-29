package com.superdeepseek.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

/** Native MCP credential storage. Robolectric has no AndroidKeyStore, so a
 *  reversible fake cipher stands in; the Keystore path is exercised on device. */
@RunWith(RobolectricTestRunner::class)
class SecureCredentialStoreTest {
    private class XorCipher : CredentialCipher {
        override fun encrypt(plain: ByteArray) = byteArrayOf(7) + plain.map { (it.toInt() xor 0x5a).toByte() }
        override fun decrypt(blob: ByteArray): ByteArray { require(blob[0] == 7.toByte()); return blob.drop(1).map { (it.toInt() xor 0x5a).toByte() }.toByteArray() }
    }
    private class BrokenCipher : CredentialCipher {
        override fun encrypt(plain: ByteArray): ByteArray = throw IllegalStateException("no keystore")
        override fun decrypt(blob: ByteArray): ByteArray = throw IllegalStateException("no keystore")
    }
    private val ctx get() = RuntimeEnvironment.getApplication()

    @Test
    fun `round trips and never stores plaintext or the server url`() {
        val store = SecureCredentialStore(ctx, XorCipher())
        assertTrue(store.put("https://mcp.example.com/mcp", "sk-secret-123"))
        assertEquals("sk-secret-123", store.get("https://mcp.example.com/mcp"))
        assertTrue(store.has("https://mcp.example.com/mcp/"))
        val raw = ctx.getSharedPreferences(SecureCredentialStore.PREFS, 0).all.toString()
        assertFalse(raw.contains("sk-secret-123"))
        assertFalse(raw.contains("mcp.example.com"))
    }

    @Test
    fun `forget removes the key`() {
        val store = SecureCredentialStore(ctx, XorCipher())
        store.put("https://a.example/mcp", "k1")
        assertTrue(store.remove("https://a.example/mcp"))
        assertNull(store.get("https://a.example/mcp"))
        assertFalse(store.remove("https://a.example/mcp"))
    }

    @Test
    fun `fails closed when the keystore is unavailable or data is corrupt`() {
        val broken = SecureCredentialStore(ctx, BrokenCipher())
        assertFalse(broken.put("https://b.example/mcp", "k"))
        SecureCredentialStore(ctx, XorCipher()).put("https://c.example/mcp", "k")
        assertNull("undecryptable (e.g. restored backup) returns null", broken.get("https://c.example/mcp"))
    }

    @Test
    fun `rejects invalid input and isolates servers`() {
        val store = SecureCredentialStore(ctx, XorCipher())
        assertFalse(store.put("", "k"))
        assertFalse(store.put("https://d.example/mcp", ""))
        assertFalse(store.put("https://d.example/mcp", "x".repeat(5000)))
        store.put("https://e.example/mcp", "one")
        store.put("https://f.example/mcp", "two")
        assertNotEquals(store.get("https://e.example/mcp"), store.get("https://f.example/mcp"))
        assertNull(SecureCredentialStore.idOf("x".repeat(401)))
    }
}
