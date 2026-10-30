package com.superdeepseek.app

import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.junit.Assert.*
import org.junit.Test
import java.net.InetAddress
import java.net.UnknownHostException

class FrameFetchPolicyTest {
    private fun ok(u: String) = FrameFetchPolicy.urlAllowed(u.toHttpUrlOrNull())
    private fun ip(s: String) = InetAddress.getByName(s)

    @Test fun `public http(s) urls pass, private and odd ones do not`() {
        assertTrue(ok("https://api.github.com/repos/x/y"))
        assertTrue(ok("http://example.com/a?b=1"))
        assertTrue(ok("https://8.8.8.8/dns"))
        assertFalse(ok("https://localhost/x"))
        assertFalse(ok("http://127.0.0.1:8080/"))
        assertFalse(ok("http://10.0.0.5/"))
        assertFalse(ok("http://192.168.1.1/"))
        assertFalse(ok("http://169.254.169.254/latest/meta-data"))
        assertFalse(ok("http://[::1]/"))
        assertFalse(ok("http://[fd00::1]/"))
        assertFalse(ok("http://[::ffff:10.0.0.1]/"))
        assertFalse(ok("https://printer.local/"))
        assertFalse(ok("https://intranet/"))
        assertFalse(ok("https://user:pw@example.com/"))
        assertFalse(ok("https://example.com:22/"))
        assertFalse(ok(null.toString()))
    }

    @Test fun `address classification covers v4 and v6 special ranges`() {
        listOf("0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1", "172.31.255.255", "192.168.0.1", "224.0.0.1", "255.255.255.255", "::1", "fe80::1", "fc00::1", "::ffff:192.168.1.1")
            .forEach { assertTrue(it, FrameFetchPolicy.isBlockedAddress(ip(it))) }
        listOf("1.1.1.1", "8.8.4.4", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111")
            .forEach { assertFalse(it, FrameFetchPolicy.isBlockedAddress(ip(it))) }
    }

    @Test fun `IPv4 embedded in NAT64, 6to4 and Teredo addresses is judged, documentation ranges blocked`() {
        // NAT64 / 6to4 wrapping a private or loopback IPv4 address
        listOf("64:ff9b::a00:1", "64:ff9b::7f00:1", "64:ff9b::c0a8:101", "64:ff9b:1::a9fe:a9fe", "2002:a00:1::1", "2002:7f00:1::",
            "2001:0:4136:e378:8000:63bf:3fff:fdd2", "100::1", "192.0.2.10", "198.51.100.7", "203.0.113.200")
            .forEach { assertTrue(it, FrameFetchPolicy.isBlockedAddress(ip(it))) }
        // ...but a public IPv4 site reached through DNS64 on an IPv6-only mobile network works
        listOf("64:ff9b::808:808", "64:ff9b::5db8:d822", "2002:808:808::1", "2001:4860:4860::8888")
            .forEach { assertFalse(it, FrameFetchPolicy.isBlockedAddress(ip(it))) }
        assertFalse(ok("http://[64:ff9b::a00:1]/"))
        assertTrue(ok("http://[64:ff9b::808:808]/"))
    }

    @Test fun `SafeDns refuses hosts resolving to private addresses (rebinding)`() {
        val rebinding = object : Dns { override fun lookup(hostname: String) = listOf(ip("93.184.216.34"), ip("10.0.0.1")) }
        try { FrameFetchPolicy.SafeDns(rebinding).lookup("evil.example"); fail() } catch (_: UnknownHostException) {}
        val public = object : Dns { override fun lookup(hostname: String) = listOf(ip("93.184.216.34")) }
        assertEquals(1, FrameFetchPolicy.SafeDns(public).lookup("example.com").size)
    }

    @Test fun `identity and hop-by-hop headers are stripped`() {
        assertFalse(FrameFetchPolicy.headerAllowed("Cookie"))
        assertFalse(FrameFetchPolicy.headerAllowed("Origin"))
        assertFalse(FrameFetchPolicy.headerAllowed("Sec-Fetch-Site"))
        assertFalse(FrameFetchPolicy.headerAllowed("X-Forwarded-For"))
        assertFalse(FrameFetchPolicy.headerAllowed("bad header"))
        assertTrue(FrameFetchPolicy.headerAllowed("Accept"))
        assertTrue(FrameFetchPolicy.headerAllowed("Content-Type"))
        assertTrue(FrameFetchPolicy.headerAllowed("Authorization"))
        assertTrue(FrameFetchPolicy.isTextual("application/json; charset=utf-8"))
        assertFalse(FrameFetchPolicy.isTextual("image/png"))
    }

    @Test fun `HopGuard stops a redirect hop to a private literal and lets public hops through`() {
        val chain = org.mockito.kotlin.mock<okhttp3.Interceptor.Chain>()
        org.mockito.kotlin.whenever(chain.request()).thenReturn(okhttp3.Request.Builder().url("http://127.0.0.1:8080/admin").build())
        try { FrameFetchPolicy.HopGuard.intercept(chain); fail() } catch (e: UnknownHostException) { assertTrue(e.message!!.contains("Blocked")) }
        org.mockito.kotlin.verify(chain, org.mockito.kotlin.never()).proceed(org.mockito.kotlin.any())
        val ok = org.mockito.kotlin.mock<okhttp3.Interceptor.Chain>()
        val req = okhttp3.Request.Builder().url("https://example.com/").build()
        org.mockito.kotlin.whenever(ok.request()).thenReturn(req)
        val resp = okhttp3.Response.Builder().request(req).protocol(okhttp3.Protocol.HTTP_1_1).code(200).message("OK").build()
        org.mockito.kotlin.whenever(ok.proceed(req)).thenReturn(resp)
        assertEquals(200, FrameFetchPolicy.HopGuard.intercept(ok).code)
    }

    @Test fun `allowLoopback permits localhost for MockWebServer only while still blocking private and metadata IPs`() {
        assertTrue(FrameFetchPolicy.urlAllowed("http://localhost:54321/page".toHttpUrlOrNull(), allowLoopback = true))
        assertTrue(FrameFetchPolicy.urlAllowed("http://127.0.0.1:41234/mcp".toHttpUrlOrNull(), allowLoopback = true))
        assertTrue(FrameFetchPolicy.urlAllowed("http://127.0.1.1:41234/mcp".toHttpUrlOrNull(), allowLoopback = true))
        assertTrue(FrameFetchPolicy.urlAllowed("http://[::1]:41234/mcp".toHttpUrlOrNull(), allowLoopback = true))
        assertFalse(FrameFetchPolicy.urlAllowed("http://localhost:54321/page".toHttpUrlOrNull(), allowLoopback = false))
        assertFalse(FrameFetchPolicy.urlAllowed("http://127.0.1.1:41234/mcp".toHttpUrlOrNull(), allowLoopback = false))
        assertFalse(FrameFetchPolicy.urlAllowed("http://[::1]:41234/mcp".toHttpUrlOrNull(), allowLoopback = false))
        assertFalse(FrameFetchPolicy.urlAllowed("http://169.254.169.254/latest/meta-data".toHttpUrlOrNull(), allowLoopback = true))
        assertFalse(FrameFetchPolicy.urlAllowed("http://192.168.1.1/admin".toHttpUrlOrNull(), allowLoopback = true))
        assertFalse(FrameFetchPolicy.urlAllowed("http://10.0.0.5/".toHttpUrlOrNull(), allowLoopback = true))
    }
}
