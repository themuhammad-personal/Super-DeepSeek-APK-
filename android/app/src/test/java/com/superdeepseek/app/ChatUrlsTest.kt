package com.superdeepseek.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ChatUrlsTest {
    @Test
    fun conversationUrlsAreRestored() {
        val url = "https://chat.deepseek.com/a/chat/s/0b8f6c1e-2d3a-4f5b-9c7d-112233445566"
        assertEquals(url, ChatUrls.restorable(url))
    }

    @Test
    fun everythingElseOpensANewChat() {
        listOf(
            null,
            "",
            "https://chat.deepseek.com/",
            "https://chat.deepseek.com/sign_in",
            "http://chat.deepseek.com/a/chat/s/abc",
            "https://evil.example/a/chat/s/abc",
            "https://chat.deepseek.com.evil.example/a/chat/s/abc",
            "https://chat.deepseek.com:444/a/chat/s/abc",
            "https://chat.deepseek.com/a/chat/s/abc?x=1",
            "https://chat.deepseek.com/a/chat/s/abc#frag",
            "https://user@chat.deepseek.com/a/chat/s/abc",
            "https://chat.deepseek.com/a/chat/s/../../x",
            "javascript:alert(1)",
        ).forEach { assertNull(it, ChatUrls.restorable(it)) }
    }

    @Test
    fun onlyTheDeepSeekChatMayUseTheBridge() {
        org.junit.Assert.assertTrue(isTrustedBridgeUrl("https://chat.deepseek.com/"))
        org.junit.Assert.assertTrue(isTrustedBridgeUrl("https://chat.deepseek.com/a/chat/s/abc?x=1"))
        listOf(
            null, "", "about:blank", "http://chat.deepseek.com/",
            "https://chat.deepseek.com.evil.example/", "https://evil.example/?chat.deepseek.com",
            "https://user@chat.deepseek.com/", "https://accounts.google.com/",
        ).forEach { org.junit.Assert.assertFalse(it.toString(), isTrustedBridgeUrl(it)) }
    }
}
