package com.superdeepseek.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DeepSeekPageSurfaceTest {
    @Test
    fun `parses WebView surface objects and retains document identity`() {
        assertEquals(
            DeepSeekPageSurfaceProbe(DeepSeekPageSurface.CHAT, "123.45"),
            parseDeepSeekPageSurfaceProbe("""{"surface":"chat","documentToken":"123.45"}"""),
        )
        assertEquals(
            DeepSeekPageSurfaceProbe(DeepSeekPageSurface.AUTH, "123.45"),
            parseDeepSeekPageSurfaceProbe("""{"surface":"auth","documentToken":"123.45"}"""),
        )
        assertEquals(
            DeepSeekPageSurfaceProbe(DeepSeekPageSurface.LOADING, "123.45"),
            parseDeepSeekPageSurfaceProbe("""{"surface":"loading","documentToken":"123.45"}"""),
        )
    }

    @Test
    fun `unknown or missing probe results fail closed`() {
        listOf(null, "", "null", "\"unexpected\"", """{"surface":"chat"}""", """{"surface":"CHAT","documentToken":"123"}""").forEach {
            assertEquals(DeepSeekPageSurface.LOADING, parseDeepSeekPageSurfaceProbe(it).surface)
        }
        assertEquals("", parseDeepSeekPageSurfaceProbe("""{"surface":"chat"}""").documentToken)
    }

    @Test
    fun `claim script checks document and live surface before setting injected marker`() {
        val script = buildDeepSeekEngineClaimScript("123.45")
        val identityCheck = script.indexOf("probe.documentToken!==\"123.45\"")
        val surfaceCheck = script.indexOf("probe.surface!=='chat'")
        val existingCheck = script.indexOf("if(window.__sdEngineInjected)return 'already'")
        val markerWrite = script.indexOf("window.__sdEngineInjected=true")

        assertTrue(identityCheck >= 0)
        assertTrue(identityCheck < surfaceCheck)
        assertTrue(surfaceCheck < existingCheck)
        assertTrue(existingCheck < markerWrite)
        assertTrue(script.contains("textarea#chat-input"))
        assertTrue(script.contains("captcha"))
    }

    @Test
    fun `claim result parser fails closed for unexpected values`() {
        assertEquals(DeepSeekEngineClaimResult.CLAIMED, parseDeepSeekEngineClaimResult("\"claimed\""))
        assertEquals(DeepSeekEngineClaimResult.ALREADY_PRESENT, parseDeepSeekEngineClaimResult("\"already\""))
        assertEquals(DeepSeekEngineClaimResult.AUTH, parseDeepSeekEngineClaimResult("\"auth\""))
        assertEquals(DeepSeekEngineClaimResult.LOADING, parseDeepSeekEngineClaimResult("\"loading\""))
        assertEquals(DeepSeekEngineClaimResult.STALE, parseDeepSeekEngineClaimResult("\"stale\""))
        assertEquals(DeepSeekEngineClaimResult.UNKNOWN, parseDeepSeekEngineClaimResult(null))
        assertEquals(DeepSeekEngineClaimResult.UNKNOWN, parseDeepSeekEngineClaimResult("\"unexpected\""))
    }

    @Test
    fun `probe checks CAPTCHA and sign-in before allowing engine injection`() {
        assertTrue(DEEPSEEK_PAGE_SURFACE_PROBE_JS.contains("captcha"))
        assertTrue(DEEPSEEK_PAGE_SURFACE_PROBE_JS.contains("hcaptcha"))
        assertTrue(DEEPSEEK_PAGE_SURFACE_PROBE_JS.contains("sign[_-]?in"))
        assertTrue(DEEPSEEK_PAGE_SURFACE_PROBE_JS.contains("path.split('/')"))
        assertTrue(DEEPSEEK_PAGE_SURFACE_PROBE_JS.contains("textarea#chat-input"))
        assertTrue(DEEPSEEK_PAGE_SURFACE_PROBE_JS.contains("return 'loading'"))
    }
}
