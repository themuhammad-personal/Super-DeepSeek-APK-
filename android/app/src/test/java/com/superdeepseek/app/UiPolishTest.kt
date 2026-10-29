package com.superdeepseek.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UiPolishTest {

    // ── Settings text rules ──────────────────────────────────────────────

    @Test
    fun `voice feature rows are hidden in english and bangla`() {
        assertTrue(UiPolish.shouldHideText("Voice Mode"))
        assertTrue(UiPolish.shouldHideText("voice mode"))
        assertTrue(UiPolish.shouldHideText("Auto-read responses"))
        assertTrue(UiPolish.shouldHideText("Voice & Audio"))
        assertTrue(UiPolish.shouldHideText("ভয়েস মোড"))
        assertTrue(UiPolish.shouldHideText("অটো-রিড রেসপন্স"))
        assertTrue(UiPolish.shouldHideText("ভয়েস ও অডিও"))
    }

    @Test
    fun `deep code rows are hidden in english and bangla`() {
        assertTrue(UiPolish.shouldHideText("Deep Code"))
        assertTrue(UiPolish.shouldHideText("Enable deep code"))
        assertTrue(UiPolish.shouldHideText("ডিপ কোড"))
    }

    @Test
    fun `legitimate settings rows stay visible`() {
        assertFalse(UiPolish.shouldHideText("Multi-turn context"))
        assertFalse(UiPolish.shouldHideText("Search providers"))
        assertFalse(UiPolish.shouldHideText("GitHub Token"))
        assertFalse(UiPolish.shouldHideText("Export all data"))
        assertFalse(UiPolish.shouldHideText("Custom CSS"))
        assertFalse(UiPolish.shouldHideText("মেমোরি লাইব্রেরি"))
        assertFalse(UiPolish.shouldHideText("Deep Research"))
        assertFalse(UiPolish.shouldHideText("Show timestamps"))
        // Web Search and DeepThink keep their SETTINGS sections.
        assertFalse(UiPolish.shouldHideText("Web Search"))
        assertFalse(UiPolish.shouldHideText("DeepThink"))
    }

    // ── Label repairs ────────────────────────────────────────────────────

    @Test
    fun `raw i18n keys have localized replacements`() {
        val about = UiPolish.LABEL_FIXES["SETTINGS.ABOUT"]
        assertEquals("About", about?.first)
        assertEquals("সম্পর্কে", about?.second)
        val tools = UiPolish.LABEL_FIXES["mcp.tools"]
        assertEquals("MCP Tools", tools?.first)
    }

    // ── Injected script contract ─────────────────────────────────────────

    @Test
    fun `mutation sweeps are throttled while the page streams`() {
        val script = UiPolish.buildScript()
        // The busy flag is released only by the trailing sweep, so a burst of
        // mutations costs two sweeps instead of two per mutation.
        assertTrue(script.contains("setTimeout(function(){pend=false;sweep(document);},380)"))
        assertFalse(script.contains("pend=false;scheduleSweep"))
    }

    @Test
    fun `script embeds every hidden selector and is idempotent`() {
        val script = UiPolish.buildScript()
        assertTrue(script.contains("__bdsUiPolished"))
        assertTrue(script.contains("MutationObserver"))
        UiPolish.HIDDEN_SELECTORS.forEach { selector ->
            val bare = selector
                .removePrefix("[data-testid=\"").removeSuffix("\"]")
                .removePrefix(".")
            assertTrue("script must embed selector: $selector", script.contains(bare))
        }
    }

    @Test
    fun `script never hides an ancestor group`() {
        // Regression guard for the wiped-advanced-settings bug: the sweep must
        // not climb to `.bds-settings-group` (or use closest at all).
        val script = UiPolish.buildScript()
        assertFalse(script.contains("closest("))
        assertFalse(script.contains("bds-settings-group\"") && script.contains("closest"))
    }

    @Test
    fun `script sweeps only dedicated row selectors`() {
        val script = UiPolish.buildScript()
        UiPolish.TEXT_SWEEP_SELECTORS.forEach { assertTrue(script.contains(it)) }
    }

    @Test
    fun `the plus sheet is left to the engine bundle`() {
        // The "+" sheet's card set is defined in the bundle itself; a DOM
        // sweep over it would only cause a flash of removed cards on open.
        val script = UiPolish.buildScript()
        assertFalse(script.contains("bds-attach-dropdown"))
        assertFalse(script.contains("bds-attach-item"))
        assertFalse(script.contains("attach-menu-deep-code"))
    }

    @Test
    fun `dead chrome is removed from the DOM, not just hidden`() {
        // Product decision: the search bars etc. must be GONE (node removal),
        // not merely display:none.
        val script = UiPolish.buildScript()
        assertTrue("dead sweep must remove nodes", script.contains("dead[k].remove()"))
        assertFalse(script.contains("dead[k].style.display"))
    }

    @Test
    fun `commands card taps insert the slash command into the composer`() {
        // The engine renders command rows but never wires onselect — the
        // polish script must provide the delegated click → composer insert.
        val script = UiPolish.buildScript()
        assertTrue(script.contains("bds-cmd-manager-builtin"))
        assertTrue(script.contains("bds-cmd-manager-item"))
        assertTrue(script.contains("bds-cmd-manager-remove"))
        assertTrue(script.contains("chat-input"))
        assertTrue(script.contains("HTMLTextAreaElement.prototype"))
    }

    @Test
    fun `polish signals engine-ui-ready to the native boot overlay`() {
        val script = UiPolish.buildScript()
        assertTrue(script.contains("AndroidBridge.onUiPolished"))
    }

    @Test
    fun `SEL and SWEEP lines are single valid JS strings`() {
        // Regression guard: a raw selector containing a quote
        // ([data-testid="…"]) inside these double-quoted JS strings produced a
        // SyntaxError that silently killed the ENTIRE injected script.
        val script = UiPolish.buildScript()
        fun isSingleValidString(marker: String): Boolean {
            val start = script.indexOf(marker)
            if (start < 0) return false
            var i = start + marker.length
            if (script.getOrNull(i) != '"') return false
            i++
            while (i < script.length) {
                when (script[i]) {
                    '\\' -> i += 2 // skip the backslash AND the escaped character
                    '"' -> return script.getOrNull(i + 1) == ';'
                    ';' -> return false // string closed before the statement
                    else -> i++
                }
            }
            return false
        }
        assertTrue("SEL is not one valid JS string", isSingleValidString("var SEL="))
        assertTrue("SWEEP is not one valid JS string", isSingleValidString("var SWEEP="))
    }

    @Test
    fun `script escapes regex patterns as json strings`() {
        val script = UiPolish.buildScript()
        assertTrue(script.contains("ভয়েস মোড"))
        assertTrue(script.contains("ডিপ কোড"))
        // Ignore-case flag is present because some rules are case-insensitive
        assertTrue(script.contains("new RegExp(p,\"i\")"))
    }

    // ── Composer control classification ──────────────────────────────────

    @Test
    fun `engine composer controls are recognised`() {
        assertTrue(UiPolish.isEngineComposerControl("bds-plus-btn", ""))
        assertTrue(UiPolish.isEngineComposerControl("bds-attach-menu-mount svelte-x", ""))
        assertTrue(UiPolish.isEngineComposerControl("bds-deep-research-toggle", ""))
        assertTrue(UiPolish.isEngineComposerControl("bds-deep-research-mount", ""))
        assertTrue(UiPolish.isEngineComposerControl("", "bds-root"))
    }

    @Test
    fun `official page controls are not classified as engine controls`() {
        assertFalse(UiPolish.isEngineComposerControl("ds-icon-button", ""))
        assertFalse(UiPolish.isEngineComposerControl("chat-input-user-input", ""))
        assertFalse(UiPolish.isEngineComposerControl("", "send-message-button"))
    }

    // ── Selector list hygiene ────────────────────────────────────────────

    @Test
    fun `hidden selector list is exactly the agreed dead set`() {
        assertEquals(
            listOf(
                ".bds-tip-bar",
                ".bds-github-link",
                ".bds-deep-code-mount",
                ".bds-category-nav",
                ".bds-drawer-search-bar",
                ".bds-advanced-search-wrapper",
            ),
            UiPolish.HIDDEN_SELECTORS,
        )
        UiPolish.HIDDEN_SELECTORS.forEach { selector ->
            val insideEngineNs = selector.startsWith(".bds-")
            assertTrue("selector must stay inside the engine namespace: $selector", insideEngineNs)
        }
    }
}
