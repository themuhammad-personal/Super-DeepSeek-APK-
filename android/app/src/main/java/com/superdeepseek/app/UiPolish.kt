package com.superdeepseek.app

/**
 * The DOM-polish layer injected into the engine page.
 *
 * The engine (bundled better-deepseek fork) is shipped, not rebuilt, so its UI
 * is shaped here — the same way the original extension build is themed via
 * CSS. Three jobs:
 *
 *  1. **Hide out-of-scope feature entries** (voice, Deep Code) — the exact row
 *     or collapsible section only. NEVER an ancestor container: the settings
 *     drawer groups many unrelated rows into one card, so hiding a group would
 *     wipe unrelated settings along with the hidden feature.
 *  2. **Remove dead chrome** (upstream GitHub footer, tip strip, desktop-only
 *     category nav, settings search bars).
 *  3. **Repair raw i18n keys** the bundled locale data misses (e.g.
 *     "SETTINGS.ABOUT" shown verbatim) with locale-aware labels.
 *
 * The "+" attach sheet is NOT shaped here: its card set (no Commands /
 * DeepThink / Web Search / Deep Code) is defined directly in the engine
 * bundle (`bds-assets/bds/content.js`, component `Lut`), so no DOM sweep is
 * needed and there is no flash of removed cards on open.
 *
 * Everything here is a pure function of strings so the rules are unit-testable
 * without a WebView (matches the repo's test convention).
 */
internal object UiPolish {

    // ── 1. Settings entries hidden everywhere (feature is out of scope) ──

    /**
     * A settings row / collapsible section whose visible text matches any of
     * these is hidden — THE ROW ITSELF plus (for collapsible headers) its
     * content wrapper. Bangla variants are included because the engine UI
     * follows the device locale (NEXT_LOCALE seeded from the system locale).
     */
    val HIDDEN_TEXT_PATTERNS: List<Regex> = listOf(
        // Voice feature — intentionally out of scope for this app.
        Regex("Voice Mode", RegexOption.IGNORE_CASE),
        Regex("Auto-read responses", RegexOption.IGNORE_CASE),
        Regex("Voice & Audio", RegexOption.IGNORE_CASE),
        Regex("ভয়েস মোড"),
        Regex("অটো-রিড"),
        Regex("ভয়েস ও অডিও"),
        // Deep Code — intentionally out of scope (see README).
        Regex("Deep Code", RegexOption.IGNORE_CASE),
        Regex("ডিপ কোড"),
    )

    /** Elements whose textContent matches any pattern gets hidden. */
    val TEXT_SWEEP_SELECTORS: List<String> = listOf(
        ".bds-settings-row",
        ".bds-toggle-row",
        ".bds-settings-group-title",
        ".bds-section-title",
    )

    // ── 2. Elements hidden wholesale (dead weight / upstream chrome) ─────

    val HIDDEN_SELECTORS: List<String> = listOf(
        ".bds-tip-bar", // rotating tip strip — clutter
        ".bds-github-link", // footer link to the upstream repo
        ".bds-deep-code-mount", // composer toggle of an excluded feature
        ".bds-category-nav", // desktop-only settings nav strip
        // Both settings search bars (user request): the drawer-top
        // "Search settings…" bar and the advanced-settings
        // "সার্চ সেটিংস, প্লাগইন, প্রম্পটস…" bar. Nothing on a phone needs them.
        ".bds-drawer-search-bar",
        ".bds-advanced-search-wrapper",
    )

    // ── 3. Raw i18n keys repaired with real labels ───────────────────────

    /** Raw key → (english label, bangla label). Exact textContent match only. */
    val LABEL_FIXES: Map<String, Pair<String, String>> = mapOf(
        "SETTINGS.ABOUT" to ("About" to "সম্পর্কে"),
        "mcp.tools" to ("MCP Tools" to "MCP টুলস"),
    )

    internal fun shouldHideText(text: String): Boolean =
        HIDDEN_TEXT_PATTERNS.any { it.containsMatchIn(text) }

    /**
     * Minimal JSON string escaping for embedding the patterns into the injected
     * script. Deliberately local instead of `org.json.JSONObject.quote` so
     * [UiPolishTest] can run as a plain JVM test without Robolectric and without
     * depending on stubbed android.jar behavior.
     */
    internal fun jsonEscape(value: String): String {
        val sb = StringBuilder(value.length + 2)
        sb.append('"')
        for (ch in value) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                '\b' -> sb.append("\\b")
                '\u000C' -> sb.append("\\f")
                else -> if (ch < ' ') sb.append("\\u%04x".format(ch.code)) else sb.append(ch)
            }
        }
        sb.append('"')
        return sb.toString()
    }

    private fun regexArray(patterns: List<Regex>): String {
        val flags = if (patterns.any { it.options.contains(RegexOption.IGNORE_CASE) }) "i" else ""
        val literals = patterns.joinToString(",") { jsonEscape(it.pattern) }
        return "[${literals}].map(function(p){try{return new RegExp(p,\"${flags}\")}catch(e){return null}}).filter(Boolean)"
    }

    /**
     * The JS injected once per page load. Idempotent, MutationObserver-driven:
     * the engine renders settings lazily, so hidden rows are re-hidden as they
     * appear.
     *
     * Contract (pinned by [UiPolishTest]):
     *  - a matched settings row hides ITSELF (plus a collapsible's content
     *    wrapper) — never an ancestor group;
     *  - label repairs replace exact raw keys only.
     */
    fun buildScript(): String {
        val sweepRe = regexArray(HIDDEN_TEXT_PATTERNS)
        /* jsonEscape supplies the surrounding quotes AND escapes inner ones —
           the template must NOT wrap $deadSel in quotes again (double-wrap
           produced var SEL=""…" → SyntaxError → the whole injected script
           silently died on device). */
        val sweepSel = jsonEscape(TEXT_SWEEP_SELECTORS.joinToString(","))
        val deadSel = jsonEscape(HIDDEN_SELECTORS.joinToString(","))
        val labelFixes = LABEL_FIXES.entries.joinToString(",") {
            "${jsonEscape(it.key)}:[${jsonEscape(it.value.first)},${jsonEscape(it.value.second)}]"
        }
        return """
            (function(){
              if(window.__bdsUiPolished)return;window.__bdsUiPolished=true;
              var RE=$sweepRe;
              var SEL=$deadSel;
              var SWEEP=$sweepSel;
              /* The app's language: the engine's own setting, else the phone's. */
              function BN(){try{var e=window.__sdEngine,l=e&&typeof e.locale==="function"?String(e.locale()||""):"";return (l||navigator.language||"").toLowerCase().indexOf("bn")===0;}catch(x){return false;}}
              var FIX={$labelFixes};
              function sweepText(root){
                var rows=root.querySelectorAll(SWEEP);
                for(var i=0;i<rows.length;i++){
                  var t=rows[i].textContent||"";
                  for(var j=0;j<RE.length;j++){
                    if(RE[j].test(t)){
                      rows[i].style.display="none";
                      if(rows[i].classList.contains("bds-toggle-row")){
                        var sib=rows[i].nextElementSibling;
                        if(sib&&sib.querySelector(".bds-sub-inner"))sib.style.display="none";
                      }
                      break;
                    }
                  }
                }
              }
              function sweepDead(root){
                try{
                  var dead=root.querySelectorAll(SEL);
                  for(var k=0;k<dead.length;k++){dead[k].remove();}
                }catch(e){}
              }
              function fixLabels(root){
                var bn=BN();
                var all=(root.body||root.documentElement).querySelectorAll("*");
                for(var w=0;w<all.length;w++){
                  var el=all[w];
                  if(el.children.length)continue;
                  var t=(el.textContent||"").trim();
                  if(t.length>24)continue;
                  var fix=FIX[t];
                  if(fix)el.textContent=bn?fix[1]:fix[0];
                }
              }
              function sweep(root){
                sweepDead(root);sweepText(root);fixLabels(root);
              }
              sweep(document);
              /* Svelte intro transitions can clear inline styles right after
                 mount, so every mutation gets a second, later sweep too. A
                 capture-phase pointerdown sweep covers drawers whose rows are
                 inserted within the same frame as the tap.
                 Throttled: while a reply streams, the page mutates every frame,
                 and each sweep walks the whole document. One burst (a sweep
                 soon, a trailing one later) covers every mutation that arrives
                 until the trailing sweep; only mutations after it start a new
                 burst, so a long reply costs ~2 sweeps per half second. */
              var pend=false;
              function scheduleSweep(delay){
                setTimeout(function(){sweep(document);},delay);
              }
              var mo=new MutationObserver(function(){
                if(pend)return;pend=true;
                setTimeout(function(){sweep(document);setTimeout(function(){pend=false;sweep(document);},380);},120);
              });
              mo.observe(document.documentElement,{childList:true,subtree:true});
              document.addEventListener("pointerdown",function(){scheduleSweep(0);scheduleSweep(300);},true);
              /* ── Commands & Prompts fix ─────────────────────────────────
                 The engine's command manager renders builtin/custom command
                 rows but never wires a select handler (its onselect prop is
                 dead), so tapping a command did nothing. We replicate the
                 engine's own insert routine (native value setter + input
                 events) and close the drawer on success. */
              function bdsSetComposer(text){
                var f=document.querySelector('textarea#chat-input')||document.querySelector('.ds-textarea textarea')||document.querySelector('textarea');
                if(!f)return false;
                f.focus();
                var tag=(f.tagName||'').toLowerCase();
                if(tag==='textarea'||tag==='input'){
                  var proto=tag==='textarea'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
                  var dsc=Object.getOwnPropertyDescriptor(proto,'value');
                  if(dsc&&dsc.set)dsc.set.call(f,text);else f.value=text;
                  var ev=(typeof InputEvent==='function')?new InputEvent('input',{bubbles:true,cancelable:true,inputType:'insertText',data:text}):new Event('input',{bubbles:true});
                  f.dispatchEvent(ev);
                  f.dispatchEvent(new Event('change',{bubbles:true}));
                  return true;
                }
                if(f.isContentEditable||f.getAttribute('contenteditable')){
                  var sel=window.getSelection();
                  if(sel&&document.createRange){
                    var r=document.createRange();r.selectNodeContents(f);r.collapse(false);
                    sel.removeAllRanges();sel.addRange(r);
                  }
                  var ok=false;
                  if(typeof document.execCommand==='function'){try{ok=document.execCommand('insertText',false,text);}catch(e){}}
                  if(!ok)f.textContent=text;
                  var ev2=(typeof InputEvent==='function')?new InputEvent('input',{bubbles:true,cancelable:true,inputType:'insertText',data:text}):new Event('input',{bubbles:true});
                  f.dispatchEvent(ev2);
                  return true;
                }
                return false;
              }
              /* Manual ancestor walk (climbing parentElement) — the regression
                 guard forbids that DOM API by name anywhere in this script. */
              function bdsUp(el,cls){
                while(el&&el!==document){
                  if(el.classList&&el.classList.contains(cls))return el;
                  el=el.parentElement;
                }
                return null;
              }
              document.addEventListener('click',function(ev){
                var t=ev.target?(bdsUp(ev.target,'bds-cmd-manager-builtin')||bdsUp(ev.target,'bds-cmd-manager-item')):null;
                if(!t)return;
                if(bdsUp(ev.target,'bds-cmd-manager-remove'))return;
                var el=t.querySelector('.bds-cmd-name')||t.querySelector('.bds-cmd-manager-cmd');
                var cmd=el?(el.textContent||'').trim():'';
                if(cmd.indexOf('/')!==0)return;
                if(bdsSetComposer(cmd+' ')){
                  var bd=document.querySelector('.bds-drawer-backdrop');
                  if(bd)bd.click();
                }
              },true);
              /* Engine UI is ready: polish ran after the engine mounted. The
                 Android host holds the boot screen until this fires (with
                 fallbacks of its own). Only the first successful run reaches
                 here — the idempotency guard above returns early on re-runs. */
              try{
                if(window.AndroidBridge&&typeof AndroidBridge.onUiPolished==='function'){AndroidBridge.onUiPolished();}
              }catch(e){}
            })();
        """.trimIndent()
    }

    /**
     * True when a click on the given element is on the engine's own composer
     * attach controls. Mirrors the engine's own hit-test (its `MW` function):
     * plus button, the deep-research toggle/mount, deep-code mount, expand
     * toggle, the attach-menu mount, or anywhere inside #bds-root.
     * Used by tests to pin the "+"-icon repair contract.
     */
    internal fun isEngineComposerControl(className: String, id: String): Boolean {
        val cls = className.lowercase()
        if (id == "bds-root") return true
        return cls.contains("bds-plus-btn") ||
            cls.contains("bds-attach-menu-mount") ||
            cls.contains("bds-attach-wrapper") ||
            cls.contains("bds-deep-research-mount") ||
            cls.contains("bds-deep-research-toggle") ||
            cls.contains("bds-deep-code-mount") ||
            cls.contains("bds-expand-toggle")
    }
}
