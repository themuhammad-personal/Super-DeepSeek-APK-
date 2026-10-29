package com.superdeepseek.app

import android.webkit.WebResourceRequest
import android.webkit.WebView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.Mockito
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.io.File

/** Runtime behavior of the isolated viewer (Robolectric). */
@RunWith(RobolectricTestRunner::class)
class GeneratedAppActivityTest {
    @Test
    fun `opens only validated cache artifacts`() {
        val a = Robolectric.buildActivity(GeneratedAppActivity::class.java, null).create().get()
        assertTrue("missing artifact must finish immediately", a.isFinishing)
    }

    @Test
    fun `intercepts only the app origin and blocks every subrequest`() {
        val ctx = RuntimeEnvironment.getApplication()
        File(ctx.cacheDir, "genui").mkdirs()
        val id = "11111111-1111-1111-1111-111111111111"
        File(ctx.cacheDir, "genui/$id.html").writeText("<main>hi</main>")
        val activity = Robolectric.buildActivity(
            GeneratedAppActivity::class.java,
            android.content.Intent(ctx, GeneratedAppActivity::class.java).putExtra("artifact", id)
        ).create().get()
        assertFalse(activity.isFinishing)
        val client = GeneratedAppWebClient("<main>hi</main>")
        val view = WebView(ctx)
        val main = Mockito.mock(WebResourceRequest::class.java)
        Mockito.`when`(main.isForMainFrame).thenReturn(true)
        Mockito.`when`(main.method).thenReturn("GET")
        Mockito.`when`(main.url).thenReturn(android.net.Uri.parse(GeneratedAppActivity.URL))
        val resp = client.shouldInterceptRequest(view, main)
        assertNotNull("app origin must be served", resp)
        assertEquals(200, resp!!.statusCode)
        val csp = resp.responseHeaders!!.get("Content-Security-Policy")!!
        assertTrue(csp.contains("default-src 'none'"))
        assertTrue(csp.contains("frame-src 'none'"))
        assertFalse(csp.contains("connect-src *"))
        val sub = Mockito.mock(WebResourceRequest::class.java)
        Mockito.`when`(sub.isForMainFrame).thenReturn(false)
        Mockito.`when`(sub.method).thenReturn("GET")
        Mockito.`when`(sub.url).thenReturn(android.net.Uri.parse("https://evil.example/x.js"))
        val blocked = client.shouldInterceptRequest(view, sub)
        assertNotNull(blocked)
        assertEquals(403, blocked!!.statusCode)
        val cdn = Mockito.mock(WebResourceRequest::class.java)
        Mockito.`when`(cdn.isForMainFrame).thenReturn(false)
        Mockito.`when`(cdn.method).thenReturn("GET")
        Mockito.`when`(cdn.url).thenReturn(android.net.Uri.parse("https://cdn.jsdelivr.net/npm/chart.js"))
        assertNull("allowlisted CDN GET passes through", client.shouldInterceptRequest(view, cdn))
        val post = Mockito.mock(WebResourceRequest::class.java)
        Mockito.`when`(post.isForMainFrame).thenReturn(false)
        Mockito.`when`(post.method).thenReturn("POST")
        Mockito.`when`(post.url).thenReturn(android.net.Uri.parse("https://cdn.jsdelivr.net/npm/chart.js"))
        assertEquals(403, client.shouldInterceptRequest(view, post)!!.statusCode)
        val http = Mockito.mock(WebResourceRequest::class.java)
        Mockito.`when`(http.isForMainFrame).thenReturn(false)
        Mockito.`when`(http.method).thenReturn("GET")
        Mockito.`when`(http.url).thenReturn(android.net.Uri.parse("http://cdn.jsdelivr.net/x.js"))
        assertEquals(403, client.shouldInterceptRequest(view, http)!!.statusCode)
    }

    @Test
    fun `loads the app origin only`() {
        val ctx = RuntimeEnvironment.getApplication()
        File(ctx.cacheDir, "genui").mkdirs()
        val id = "22222222-2222-2222-2222-222222222222"
        File(ctx.cacheDir, "genui/$id.html").writeText("<main>hi</main>")
        val activity = Robolectric.buildActivity(
            GeneratedAppActivity::class.java,
            android.content.Intent(ctx, GeneratedAppActivity::class.java).putExtra("artifact", id)
        ).create().get()
        val client = GeneratedAppWebClient("<main>hi</main>")
        val req = Mockito.mock(WebResourceRequest::class.java)
        Mockito.`when`(req.isForMainFrame).thenReturn(true)
        Mockito.`when`(req.method).thenReturn("GET")
        Mockito.`when`(req.url).thenReturn(android.net.Uri.parse("https://other.invalid/x"))
        assertTrue(client.shouldOverrideUrlLoading(WebView(ctx), req))
    }
}
