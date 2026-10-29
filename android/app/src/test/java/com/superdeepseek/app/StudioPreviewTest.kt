package com.superdeepseek.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StudioPreviewTest {

    @Test
    fun `a guest path maps to a preview URL and back`() {
        val url = StudioPreview.urlFor("/root/workspace/my site/index.html")
        assertEquals("https://workspace.invalid/root/workspace/my%20site/index.html", url)
        assertEquals("/root/workspace/my site/index.html", StudioPreview.guestPathOf(url.removePrefix(StudioPreview.ORIGIN)))
        assertEquals("https://workspace.invalid/root/workspace/app/", StudioPreview.urlFor("/root/workspace/app", isDir = true))
        assertEquals("https://workspace.invalid/root/%E0%A6%AC%E0%A6%BE.md", StudioPreview.urlFor("/root/বা.md"))
        assertEquals("/root/বা.md", StudioPreview.guestPathOf("/root/%E0%A6%AC%E0%A6%BE.md"))
    }

    @Test
    fun `URL paths never climb out of the root`() {
        assertNull(StudioPreview.guestPathOf("/../etc/passwd"))
        assertNull(StudioPreview.guestPathOf("/root/%2e%2e/%2e%2e/%2e%2e/data"))
        assertNull(StudioPreview.guestPathOf("/a%00b"))
        assertNull(StudioPreview.guestPathOf("/bad%zz"))
        assertEquals("/root/b", StudioPreview.guestPathOf("/root/a/../b"))
        assertEquals("/", StudioPreview.guestPathOf(""))
        assertEquals("/a+b", StudioPreview.guestPathOf("/a+b"))
        assertEquals("/root/x", StudioPreview.guestPathOf("//root/./x/"))
    }

    @Test
    fun `display shows the guest path for files and the URL for servers`() {
        assertEquals("/root/workspace/a.md", StudioPreview.displayOf("https://workspace.invalid/root/workspace/a.md?raw=1#top"))
        assertEquals("http://127.0.0.1:8000/", StudioPreview.displayOf("http://127.0.0.1:8000/"))
        assertTrue(StudioPreview.isPreviewUrl("https://workspace.invalid/x"))
        assertFalse(StudioPreview.isPreviewUrl("https://workspace.invalid.evil.com/x"))
    }

    @Test
    fun `kinds and types`() {
        assertEquals(StudioPreview.Kind.PAGE, StudioPreview.kind("index.HTML"))
        assertEquals(StudioPreview.Kind.MARKDOWN, StudioPreview.kind("README.md"))
        assertEquals(StudioPreview.Kind.IMAGE, StudioPreview.kind("/a/logo.svg"))
        assertEquals(StudioPreview.Kind.VIDEO, StudioPreview.kind("clip.mp4"))
        assertEquals(StudioPreview.Kind.OTHER, StudioPreview.kind("main.py"))
        assertFalse(StudioPreview.isPreviewable("Makefile"))
        assertEquals("text/javascript", StudioPreview.mimeOf("app.mjs"))
        assertEquals("application/octet-stream", StudioPreview.mimeOf("blob"))
        assertTrue(StudioPreview.isText("image/svg+xml"))
        assertFalse(StudioPreview.isText("image/png"))
    }

    @Test
    fun `listing links are relative and escaped`() {
        val html = StudioPreview.listingPage("/root/workspace", listOf("b.txt" to false, "<x>" to true, "a b" to true), dark = true)
        assertTrue(html.contains("href=\"../\""))
        assertTrue(html.contains("href=\"a%20b/\""))
        assertTrue(html.contains("&lt;x&gt;/"))
        assertFalse(html.contains("<x>"))
        assertTrue(html.indexOf("a b/") < html.indexOf("b.txt"))
    }

    @Test
    fun `media pages point at the raw file`() {
        val html = StudioPreview.mediaPage("cat pic.png", StudioPreview.Kind.IMAGE, dark = false)
        assertTrue(html.contains("<img src=\"cat%20pic.png?raw=1\""))
        assertTrue(StudioPreview.mediaPage("a.mp4", StudioPreview.Kind.VIDEO, true).contains("<video src=\"a.mp4?raw=1\" controls"))
    }

    @Test
    fun `redirect page is safe`() {
        val html = StudioPreview.redirectPage("https://workspace.invalid/a\"</script>/")
        assertFalse(html.contains("</script>/"))
    }
}

class MarkdownTest {

    private fun md(s: String) = Markdown.toHtml(s).trim()

    @Test
    fun `headings paragraphs and emphasis`() {
        assertEquals("<h1>Title</h1>\n<p>Some <strong>bold</strong> and <em>it</em> and <del>gone</del>.</p>",
                md("# Title\n\nSome **bold** and *it* and ~~gone~~."))
        assertEquals("<h3>A</h3>", md("### A ###"))
        assertEquals("<p>line one<br>line two</p>", md("line one\nline two"))
        assertEquals("<p>snake_case_name stays</p>", md("snake_case_name stays"))
    }

    @Test
    fun `raw HTML is text`() {
        assertEquals("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>", md("<script>alert(1)</script>"))
    }

    @Test
    fun `code spans and fences are literal`() {
        assertEquals("<p>Run <code>a *b* &lt;c&gt;</code> now</p>", md("Run `a *b* <c>` now"))
        assertEquals("<pre><code class=\"language-py\">x = 1 **2\n&lt;b&gt;</code></pre>", md("```py\nx = 1 **2\n<b>\n```"))
    }

    @Test
    fun `links and images, unsafe schemes dropped, URLs untouched by emphasis`() {
        assertEquals("<p><a href=\"https://a.b/_x_/\">site</a></p>", md("[site](https://a.b/_x_/)"))
        assertEquals("<p><img src=\"img/a_b_c.png\" alt=\"pic\"></p>", md("![pic](img/a_b_c.png)"))
        assertEquals("<p><a href=\"#\">x</a></p>", md("[x](javascript:alert(1))"))
        assertEquals("<p><a href=\"https://x.y\">https://x.y</a></p>", md("<https://x.y>"))
    }

    @Test
    fun `lists nested ordered and tasks`() {
        assertEquals("<ul>\n<li>a\n<ul>\n<li>b</li>\n</ul>\n</li>\n<li>c</li>\n</ul>", md("- a\n  - b\n- c"))
        assertEquals("<ol start=\"3\">\n<li>x</li>\n<li>y</li>\n</ol>", md("3. x\n4. y"))
        assertEquals("<ul>\n<li><input type=\"checkbox\" checked disabled> done</li>\n<li><input type=\"checkbox\" disabled> todo</li>\n</ul>",
                md("- [x] done\n- [ ] todo"))
        assertEquals("<ul>\n<li>a</li>\n</ul>\n<h2>After</h2>", md("- a\n## After"))
    }

    @Test
    fun `quotes rules and tables`() {
        assertEquals("<blockquote>\n<p>quoted <em>text</em></p>\n</blockquote>", md("> quoted *text*"))
        assertEquals("<p>a</p>\n<hr>\n<p>b</p>", md("a\n\n---\n\nb"))
        val t = md("| A | B |\n|:--|--:|\n| 1 | `x` |\n| 2 | 3 |")
        assertTrue(t, t.startsWith("<table><thead><tr><th>A</th>"))
        assertTrue(t, t.contains("<th style=\"text-align:right\">B</th>"))
        assertTrue(t, t.contains("<td>2</td><td style=\"text-align:right\">3</td>"))
    }
}
