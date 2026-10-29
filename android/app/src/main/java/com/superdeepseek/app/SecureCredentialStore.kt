package com.superdeepseek.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Encrypts/decrypts small secrets. Production uses a non-exportable Android Keystore key. */
internal interface CredentialCipher {
    fun encrypt(plain: ByteArray): ByteArray
    fun decrypt(blob: ByteArray): ByteArray
}

/**
 * AES-256-GCM with a hardware-backed (where available) Android Keystore key.
 * Blob layout: [ivLength:1][iv][ciphertext+tag]. The key never leaves the
 * Keystore, is not backed up, and a restored blob simply fails to decrypt
 * (fail closed). See developer.android.com/privacy-and-security/keystore.
 */
internal class KeystoreCredentialCipher(private val alias: String = "sds_mcp_credentials_v1") : CredentialCipher {
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return gen.generateKey()
    }

    override fun encrypt(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = cipher.iv
        val ct = cipher.doFinal(plain)
        return byteArrayOf(iv.size.toByte()) + iv + ct
    }

    override fun decrypt(blob: ByteArray): ByteArray {
        require(blob.size > 13) { "blob too short" }
        val ivLen = blob[0].toInt() and 0xff
        require(ivLen in 12..16 && blob.size > 1 + ivLen) { "bad iv" }
        val iv = blob.copyOfRange(1, 1 + ivLen)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        return cipher.doFinal(blob.copyOfRange(1 + ivLen, blob.size))
    }
}

/**
 * Native-only storage for MCP server credentials. Secrets are never returned
 * to JavaScript: the bridge exposes only "is a key stored" and "forget".
 * Every failure (no Keystore, corrupted blob, restored backup) returns
 * null/false instead of throwing, so callers fail closed.
 */
class SecureCredentialStore internal constructor(
    context: Context,
    private val cipher: CredentialCipher
) {
    constructor(context: Context) : this(context, KeystoreCredentialCipher())

    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun put(serverUrl: String, secret: String): Boolean {
        val id = idOf(serverUrl) ?: return false
        if (secret.isEmpty() || secret.length > MAX_SECRET) return false
        return runCatching {
            val blob = cipher.encrypt(secret.toByteArray(Charsets.UTF_8))
            prefs.edit().putString(id, Base64.encodeToString(blob, Base64.NO_WRAP)).apply()
        }.isSuccess
    }

    fun get(serverUrl: String): String? {
        val id = idOf(serverUrl) ?: return null
        val stored = prefs.getString(id, null) ?: return null
        return runCatching { String(cipher.decrypt(Base64.decode(stored, Base64.NO_WRAP)), Charsets.UTF_8) }
            .getOrNull()?.takeIf { it.isNotEmpty() }
    }

    fun has(serverUrl: String): Boolean = get(serverUrl) != null

    fun remove(serverUrl: String): Boolean {
        val id = idOf(serverUrl) ?: return false
        val had = prefs.contains(id)
        prefs.edit().remove(id).apply()
        return had
    }

    companion object {
        const val PREFS = "sds_secure_credentials"
        private const val MAX_SECRET = 4096

        /** Preference key: SHA-256 of the normalized server URL (the URL itself is not stored). */
        internal fun idOf(serverUrl: String): String? {
            val s = serverUrl.trim().trimEnd('/')
            if (s.isEmpty() || s.length > 400) return null
            val digest = MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8))
            return "k_" + digest.joinToString("") { "%02x".format(it) }
        }
    }
}
