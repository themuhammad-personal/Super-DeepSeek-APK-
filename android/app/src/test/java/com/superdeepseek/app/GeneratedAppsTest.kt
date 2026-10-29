package com.superdeepseek.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** File handling for the isolated app viewer and the share sheet (pure JVM). */
class GeneratedAppsTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun `writes uuid named html the viewer accepts and prunes old apps`() {
        val cache = tmp.newFolder("cache")
        val ids = (1..12).map { i -> GeneratedApps.write(cache, "<main>$i</main>").also { File(cache, "genui/$it.html").setLastModified(i * 1000L) } }
        val id = ids.last()
        assertTrue(Regex("^[a-f0-9-]{36}$").matches(id))
        assertEquals("<main>12</main>", File(cache, "genui/$id.html").readText())
        val apps = File(cache, "genui").listFiles()!!.filter { it.name.endsWith(".html") }
        assertTrue("bounded file count", apps.size <= GeneratedApps.KEEP_APPS)
    }

    @Test
    fun `never prunes mcp viewer documents`() {
        val cache = tmp.newFolder("cache2")
        File(cache, "genui").mkdirs()
        val mcp = File(cache, "genui/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.mcp.html").apply { writeText("mcp"); setLastModified(1) }
        repeat(12) { GeneratedApps.write(cache, "<p>$it</p>") }
        assertTrue(mcp.exists())
    }

    @Test
    fun `rejects empty and oversized documents`() {
        assertFalse(GeneratedApps.acceptable(""))
        assertFalse(GeneratedApps.acceptable("   "))
        assertFalse(GeneratedApps.acceptable("x".repeat(GeneratedApps.MAX_HTML_CHARS + 1)))
        assertTrue(GeneratedApps.acceptable("<main/>"))
    }

    @Test
    fun `share files stay inside the cache share folder`() {
        val cache = tmp.newFolder("cache3")
        val f = GeneratedApps.writeShare(cache, "../../evil.html", "x".toByteArray())
        assertTrue(f.canonicalPath.startsWith(File(cache, "share").canonicalPath))
        assertFalse(f.name.contains("/"))
        assertEquals("x", f.readText())
        repeat(15) { GeneratedApps.writeShare(cache, "a.json", "{}".toByteArray()) }
        assertTrue(File(cache, "share").listFiles()!!.size <= GeneratedApps.KEEP_SHARES)
    }

    @Test
    fun `share mime allowlist excludes executable or archive types`() {
        assertTrue("text/html" in GeneratedApps.SHARE_MIME)
        assertTrue("image/png" in GeneratedApps.SHARE_MIME)
        assertFalse("application/vnd.android.package-archive" in GeneratedApps.SHARE_MIME)
        assertFalse("application/javascript" in GeneratedApps.SHARE_MIME)
    }
}
