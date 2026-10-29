package com.superdeepseek.app

import org.json.JSONObject

/**
 * Detects when the official DeepSeek WebView is showing its own authentication
 * flow versus the actual chat. Fail closed: unknown/loading pages are never
 * given the Super DeepSeek engine until the native WebView can see a composer.
 */
internal enum class DeepSeekPageSurface {
    CHAT,
    AUTH,
    LOADING,
}

internal data class DeepSeekPageSurfaceProbe(
    val surface: DeepSeekPageSurface,
    val documentToken: String,
)

/** The probe returns a JSON object; an absent document token fails closed. */
internal fun parseDeepSeekPageSurfaceProbe(raw: String?): DeepSeekPageSurfaceProbe {
    val result = raw?.let { runCatching { JSONObject(it) }.getOrNull() }
        ?: return DeepSeekPageSurfaceProbe(DeepSeekPageSurface.LOADING, "")
    val token = result.optString("documentToken", "")
    if (token.isBlank() || token == "null") {
        return DeepSeekPageSurfaceProbe(DeepSeekPageSurface.LOADING, "")
    }
    val surface = when (result.optString("surface")) {
        "chat" -> DeepSeekPageSurface.CHAT
        "auth" -> DeepSeekPageSurface.AUTH
        else -> DeepSeekPageSurface.LOADING
    }
    return DeepSeekPageSurfaceProbe(surface, token)
}

internal enum class DeepSeekEngineClaimResult {
    CLAIMED,
    ALREADY_PRESENT,
    AUTH,
    LOADING,
    STALE,
    UNKNOWN,
}

/** WebView.evaluateJavascript returns a JSON-quoted string for JS string values. */
internal fun parseDeepSeekEngineClaimResult(raw: String?): DeepSeekEngineClaimResult =
    when (raw?.trim()?.removeSurrounding("\"")?.trim()) {
        "claimed" -> DeepSeekEngineClaimResult.CLAIMED
        "already" -> DeepSeekEngineClaimResult.ALREADY_PRESENT
        "auth" -> DeepSeekEngineClaimResult.AUTH
        "loading" -> DeepSeekEngineClaimResult.LOADING
        "stale" -> DeepSeekEngineClaimResult.STALE
        else -> DeepSeekEngineClaimResult.UNKNOWN
    }

/**
 * Re-probes the live page and claims the engine only when the document identity
 * and visible surface still match. The check and marker write execute atomically
 * in one JavaScript turn, closing the asset-loading race without modifying the DOM.
 */
internal fun buildDeepSeekEngineClaimScript(documentToken: String): String =
    "(function(){var probe=($DEEPSEEK_PAGE_SURFACE_PROBE_JS);" +
        "if(probe.documentToken!==${JSONObject.quote(documentToken)})return 'stale';" +
        "if(probe.surface!=='chat')return probe.surface==='auth'?'auth':'loading';" +
        "if(window.__sdEngineInjected)return 'already';" +
        "window.__sdEngineInjected=true;return 'claimed';})()"

internal const val DEEPSEEK_PAGE_POLL_MS = 700L
internal const val DEEPSEEK_AUTH_POLL_MS = 1200L

/**
 * Runs in the main frame only. It does not read or alter credentials, CAPTCHA
 * responses, cookies, or tokens. It only classifies the visible page surface.
 */
internal val DEEPSEEK_PAGE_SURFACE_PROBE_JS = """
    (function () {
      var surface = (function () {
      try {
        function visible(el) {
          if (!el) return false;
          var style = window.getComputedStyle(el);
          var rect = el.getBoundingClientRect();
          return rect.width > 1 && rect.height > 1 &&
            style.display !== 'none' && style.visibility !== 'hidden' &&
            Number(style.opacity || 1) > 0.01;
        }
        function anyVisible(selector) {
          var nodes;
          try { nodes = document.querySelectorAll(selector); } catch (_) { return false; }
          for (var i = 0; i < nodes.length; i++) if (visible(nodes[i])) return true;
          return false;
        }

        // A visible challenge takes precedence over the composer: a session can
        // expire and challenge an otherwise chat-shaped page.
        var challengeNodes = document.querySelectorAll(
          'iframe[src], [id*="captcha"], [id*="Captcha"], [class*="captcha"], ' +
          '[class*="Captcha"], [id*="challenge"], [class*="challenge"], ' +
          '[id*="turnstile"], [class*="turnstile"]'
        );
        for (var c = 0; c < challengeNodes.length; c++) {
          var node = challengeNodes[c];
          if (!visible(node)) continue;
          var signal = [
            node.id || '',
            typeof node.className === 'string' ? node.className : '',
            node.getAttribute('src') || '',
            node.getAttribute('title') || '',
            node.getAttribute('aria-label') || ''
          ].join(' ').toLowerCase();
          if (/(captcha|hcaptcha|recaptcha|turnstile|cf-challenge|challenge-widget)/.test(signal)) {
            return 'auth';
          }
        }

        if (anyVisible('textarea#chat-input, .ds-textarea textarea, textarea[placeholder], [contenteditable="true"]')) {
          return 'chat';
        }

        var path = String(location.pathname || '').toLowerCase();
        var pathParts = path.split('/');
        for (var p = 0; p < pathParts.length; p++) {
          if (/^(sign[_-]?in|log[_-]?in|login|sign[_-]?up|register|auth)$/.test(pathParts[p])) {
            return 'auth';
          }
        }

        var fields = document.querySelectorAll('input, textarea');
        var hasAuthField = false;
        for (var f = 0; f < fields.length; f++) {
          var field = fields[f];
          if (!visible(field)) continue;
          if (field.closest && field.closest('[data-sd-owned]')) continue;
          var type = String(field.type || '').toLowerCase();
          var autocomplete = String(field.getAttribute('autocomplete') || '').toLowerCase();
          if (type === 'password' || type === 'email' || type === 'tel' ||
              autocomplete === 'one-time-code' || autocomplete === 'email' ||
              autocomplete === 'current-password' || autocomplete === 'new-password') {
            hasAuthField = true;
            break;
          }
        }
        var text = String((document.body && document.body.innerText) || '').slice(0, 6000);
        var authCopy = /(sign in|log in|log-in|login|sign up|register|create account|continue with google|continue with apple|verification code|one.time code|send code|登录|登入|注册|验证码|লগইন|সাইন ইন|নিবন্ধন|যাচাইকরণ কোড)/i.test(text);
        if (hasAuthField || (authCopy && anyVisible('button, [role="button"], a'))) return 'auth';

        // Loading/unknown pages fail closed; keep checking until chat appears.
        return 'loading';
      } catch (_) {
        return 'loading';
      }
      })();
      return {
        surface: surface,
        documentToken: String(
          window.performance &&
          (window.performance.timeOrigin ||
            (window.performance.timing && window.performance.timing.navigationStart)) || ''
        )
      };
    })()
""".trimIndent()
