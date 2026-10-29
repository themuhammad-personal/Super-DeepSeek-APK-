package com.superdeepseek.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The system bars take the page colour: measured on screen, or estimated from CSS. */
class SystemBarColorTest {

    @Test
    fun `parses the JSON-quoted probe result`() {
        assertEquals(0xFFFFFFFF.toInt(), parseRgb("\"255,255,255\""))
        assertEquals(0xFF292A2D.toInt(), parseRgb("\"41,42,45\""))
        assertEquals(0xFF010203.toInt(), parseRgb("1, 2, 3"))
    }

    @Test
    fun `rejects empty or malformed probe results`() {
        assertNull(parseRgb(null))
        assertNull(parseRgb("\"\""))
        assertNull(parseRgb("null"))
        assertNull(parseRgb("\"12,34\""))
        assertNull(parseRgb("\"300,0,0\""))
        assertNull(parseRgb("\"a,b,c\""))
    }

    @Test
    fun `light pages get dark bar icons, dark pages light icons`() {
        assertTrue(isLightColor(0xFFFFFFFF.toInt()))
        assertTrue(isLightColor(0xFFF7F7F8.toInt()))
        assertFalse(isLightColor(0xFF292A2D.toInt()))
        assertFalse(isLightColor(0xFF070A1C.toInt()))
    }

    @Test
    fun `dominant colour of a strip ignores icon and text pixels`() {
        val white = 0xFFFFFFFF.toInt()
        val icon = 0xFF0D0D0D.toInt()
        val strip = IntArray(100) { if (it in 10..24 || it in 80..89) icon else white }
        assertEquals(white, dominantColor(strip))
    }

    @Test
    fun `dominant colour is opaque and needs a clear majority`() {
        // Alpha is forced opaque (a window copy can report 0 alpha on some devices).
        assertEquals(0xFF1E1F23.toInt(), dominantColor(IntArray(10) { 0x001E1F23 }))
        // A gradient with no clear winner is not trusted.
        assertNull(dominantColor(IntArray(100) { 0xFF000000.toInt() or (it * 0x010101) }))
        assertNull(dominantColor(IntArray(0)))
    }

    @Test
    fun `only clearly dark colours count as the chat's dark background`() {
        // Chat dark backgrounds are well under the 70 threshold used by MainActivity...
        assertTrue(perceivedLuminance(0xFF1E1F23.toInt()) < 70.0)
        assertTrue(perceivedLuminance(0xFF292A2D.toInt()) < 70.0)
        // ...while a 50% black scrim over a white page is not.
        assertTrue(perceivedLuminance(0xFF808080.toInt()) > 70.0)
        assertEquals(255.0, perceivedLuminance(0xFFFFFFFF.toInt()), 0.001)
    }
}
