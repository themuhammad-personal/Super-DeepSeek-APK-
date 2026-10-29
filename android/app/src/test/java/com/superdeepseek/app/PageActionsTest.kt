package com.superdeepseek.app

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import java.io.File
import java.nio.file.Files
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PageActionsTest {

    @Test
    fun `plain launches are not requests`() {
        assertNull(parseIncomingIntent(null))
        assertNull(parseIncomingIntent(Intent(Intent.ACTION_MAIN)))
    }

    @Test
    fun `shared text joins subject and body`() {
        val intent = Intent(Intent.ACTION_SEND).setType("text/plain")
            .putExtra(Intent.EXTRA_SUBJECT, "Title")
            .putExtra(Intent.EXTRA_TEXT, "https://example.com/a")
        assertEquals(IncomingRequest.Share("Title\n\nhttps://example.com/a", emptyList()), parseIncomingIntent(intent))
        assertEquals("link", joinSharedText("link", "link"))
        assertEquals("", joinSharedText(null, "  "))
    }

    @Test
    fun `shared files come from EXTRA_STREAM and clip data without duplicates`() {
        val a = Uri.parse("content://p/a.pdf")
        val b = Uri.parse("content://p/b.zip")
        val single = Intent(Intent.ACTION_SEND).setType("application/pdf").putExtra(Intent.EXTRA_STREAM, a)
        single.clipData = ClipData.newRawUri("", a)
        assertEquals(IncomingRequest.Share("", listOf(a)), parseIncomingIntent(single))

        val multi = Intent(Intent.ACTION_SEND_MULTIPLE).setType("*/*")
            .putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(a, b))
        assertEquals(IncomingRequest.Share("", listOf(a, b)), parseIncomingIntent(multi))

        assertNull(parseIncomingIntent(Intent(Intent.ACTION_SEND).setType("*/*")))
    }

    @Test
    fun `selected text from other apps`() {
        val intent = Intent(Intent.ACTION_PROCESS_TEXT).putExtra(Intent.EXTRA_PROCESS_TEXT, " explain this ")
        assertEquals(IncomingRequest.Share("explain this", emptyList()), parseIncomingIntent(intent))
    }

    @Test
    fun `shortcuts and deep links`() {
        assertEquals(IncomingRequest.Shortcut("new_chat"),
            parseIncomingIntent(Intent(Intent.ACTION_VIEW).putExtra(EXTRA_BDS_ACTION, "new_chat")))
        assertEquals(IncomingRequest.Shortcut("deep_research"),
            parseIncomingIntent(Intent(Intent.ACTION_VIEW).putExtra(EXTRA_BDS_ACTION, "DEEP_RESEARCH")))
        assertNull(parseIncomingIntent(Intent(Intent.ACTION_VIEW).putExtra(EXTRA_BDS_ACTION, "format_disk")))

        val link = Intent(Intent.ACTION_VIEW, Uri.parse("https://chat.deepseek.com/a/chat/s/123"))
        assertEquals(IncomingRequest.DeepLink("https://chat.deepseek.com/a/chat/s/123"), parseIncomingIntent(link))
        assertFalse(isChatDeepLink(Uri.parse("http://chat.deepseek.com/")))
        assertFalse(isChatDeepLink(Uri.parse("https://evil.com/chat.deepseek.com")))
    }

    @Test
    fun `share json carries blob entries without inline content`() {
        val json = JSONObject(buildShareActionJson(
            "hi",
            listOf(
                PickedFile("a.pdf", "", "base64", "application/pdf", "/__sd/blob/x", 10),
                PickedFile("b.txt", "inline"),
            ),
            listOf(SkippedFile("c.iso", "too-large")),
        ))
        assertEquals("share", json.getString("type"))
        assertEquals("hi", json.getString("text"))
        val files = json.getJSONArray("files")
        assertEquals("/__sd/blob/x", files.getJSONObject(0).getString("blob"))
        assertEquals("", files.getJSONObject(0).getString("content"))
        assertEquals("base64", files.getJSONObject(0).getString("encoding"))
        assertTrue(files.getJSONObject(1).isNull("blob"))
        assertEquals("inline", files.getJSONObject(1).getString("content"))
        assertEquals("too-large", json.getJSONArray("skipped").getJSONObject(0).getString("reason"))
    }

    @Test
    fun `page action script quotes the payload`() {
        val script = buildPageActionScript(buildDeepLinkActionJson("https://chat.deepseek.com/'</script>"))
        assertTrue(script.contains("window.__sdNative"))
        assertFalse(script.contains("'</script>"))
    }

    @Test
    fun `old camera captures are removed`() {
        val dir = Files.createTempDirectory("cap").toFile()
        val now = 10L * 24 * 60 * 60 * 1000
        fun make(name: String, age: Long) = File(dir, name).apply { writeText("x"); setLastModified(now - age) }
        val old = make("capture-1.jpg", 25L * 60 * 60 * 1000)
        val fresh = make("capture-2.jpg", 60_000)
        val other = make("other.jpg", 25L * 60 * 60 * 1000)

        assertEquals(1, cleanupOldCaptures(dir, now))
        assertFalse(old.exists())
        assertTrue(fresh.exists())
        assertTrue(other.exists())
        dir.deleteRecursively()
    }

    @Test
    fun `renderer recovery is capped per minute`() {
        RendererCrashGuard.reset()
        assertTrue(RendererCrashGuard.shouldRecover(0))
        assertTrue(RendererCrashGuard.shouldRecover(1_000))
        assertTrue(RendererCrashGuard.shouldRecover(2_000))
        assertFalse(RendererCrashGuard.shouldRecover(3_000))
        assertTrue(RendererCrashGuard.shouldRecover(200_000))
        RendererCrashGuard.reset()
    }
}
