package com.superdeepseek.app

import android.annotation.SuppressLint
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.*
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import java.io.ByteArrayInputStream
import java.io.File

/** Contextual artifact viewer, not navigation. Deliberately has NO native JS bridge.
 * Navigations and every subrequest except read-only GETs to a short list of public library
 * CDNs are denied in native code, in addition to response-header CSP. No chat bridge here.
 */
class GeneratedAppActivity : ComponentActivity() {
    private var web: WebView? = null
    private val timer = Handler(Looper.getMainLooper())
    private val stop = Runnable { dispose(); finish() }
    private var html = ""
    private var artifactFile: File? = null
    private var showingCode = false
    private var palette: Palette? = null

    /** Same tokens as the in-chat viewer (sd-genui.css). */
    private class Palette(night: Boolean) {
        val bg = if (night) 0xFF1F2023.toInt() else 0xFFFFFFFF.toInt()
        val bg2 = if (night) 0xFF2A2B2F.toInt() else 0xFFF3F4F6.toInt()
        val fg = if (night) 0xFFECECEE.toInt() else 0xFF1B1C1F.toInt()
        val fg2 = if (night) 0xFFA4A7AE.toInt() else 0xFF5F636B.toInt()
        val fg3 = if (night) 0xFF7C8088.toInt() else 0xFF8E929A.toInt()
        val line = if (night) 0x1FFFFFFF else 0x1A000000
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val id = intent?.getStringExtra("artifact") ?: return finish()
        if (!Regex("^[a-f0-9-]{36}$").matches(id)) return finish()
        val file = File(cacheDir, "genui/$id.html")
        if (!file.isFile || file.length() > 1000000) return finish()
        artifactFile = file
        html = file.readText()
        val night = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES
        val c = Palette(night)
        val dp = resources.displayMetrics.density
        fun px(v: Int) = (v * dp).toInt()
        WindowCompat.setDecorFitsSystemWindows(window, false)
        @Suppress("DEPRECATION")
        run {
            window.statusBarColor = Color.TRANSPARENT
            window.navigationBarColor = Color.TRANSPARENT
        }
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !night
            isAppearanceLightNavigationBars = !night
        }
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(c.bg) }
        ViewCompat.setOnApplyWindowInsetsListener(layout, ::applyRootWindowInsets)
        installSmoothImeInsetAnimation(layout)
        // Claude-style header: close · title/subtitle · Preview|Code · re-run · share
        val ripple = android.util.TypedValue().also { theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, it, true) }.resourceId
        fun iconButton(glyph: String, desc: String, onClick: () -> Unit) = TextView(this).apply {
            text = glyph; contentDescription = desc; textSize = 18f; setTextColor(c.fg2); gravity = android.view.Gravity.CENTER
            minWidth = px(44); minHeight = px(44); if (ripple != 0) setBackgroundResource(ripple); setOnClickListener { onClick() }
        }
        val bar = LinearLayout(this).apply { gravity = android.view.Gravity.CENTER_VERTICAL; setPadding(px(4), px(4), px(8), px(4)) }
        bar.addView(iconButton("\u2715", getString(R.string.viewer_close)) { finish() })
        val titles = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(px(4), 0, px(8), 0) }
        val docTitle = Regex("<title>([^<]{1,80})</title>", RegexOption.IGNORE_CASE).find(html)?.groupValues?.get(1)?.trim()?.takeIf { it.isNotEmpty() } ?: getString(R.string.viewer_untitled)
        titles.addView(TextView(this).apply { text = docTitle; textSize = 15f; setTextColor(c.fg); maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END; typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL) })
        titles.addView(TextView(this).apply { text = getString(R.string.viewer_subtitle); textSize = 12f; setTextColor(c.fg3); maxLines = 1 })
        bar.addView(titles, LinearLayout.LayoutParams(0, -2, 1f))
        val seg = LinearLayout(this).apply {
            background = android.graphics.drawable.GradientDrawable().apply { cornerRadius = px(10).toFloat(); setColor(c.bg2) }
            setPadding(px(2), px(2), px(2), px(2))
        }
        val segViews = mutableListOf<TextView>()
        fun paintSeg() = segViews.forEachIndexed { i, v ->
            val on = (i == 1) == showingCode
            v.setTextColor(if (on) c.fg else c.fg3)
            v.background = if (on) android.graphics.drawable.GradientDrawable().apply { cornerRadius = px(8).toFloat(); setColor(c.bg); setStroke(px(1) / 2 + 1, c.line) } else null
        }
        listOf(getString(R.string.viewer_preview), getString(R.string.viewer_code)).forEachIndexed { i, label ->
            val v = TextView(this).apply {
                text = label; textSize = 13f; gravity = android.view.Gravity.CENTER; setPadding(px(12), 0, px(12), 0); minHeight = px(32)
                contentDescription = label
                setOnClickListener { val code = i == 1; if (code != showingCode) { showingCode = code; paintSeg(); show(layout) } }
            }
            segViews.add(v); seg.addView(v, LinearLayout.LayoutParams(-2, px(32)))
        }
        paintSeg()
        bar.addView(seg)
        bar.addView(iconButton("\u21BB", getString(R.string.viewer_rerun)) { if (!showingCode) web?.reload() })
        bar.addView(iconButton("\u2197", getString(R.string.viewer_share)) {
            android.app.AlertDialog.Builder(this@GeneratedAppActivity)
                .setTitle(R.string.viewer_share_title)
                .setMessage(R.string.viewer_share_message)
                .setNegativeButton(R.string.viewer_cancel, null)
                .setPositiveButton(R.string.viewer_share) { _, _ ->
                    runCatching {
                        val uri = androidx.core.content.FileProvider.getUriForFile(this@GeneratedAppActivity, "$packageName.fileprovider", artifactFile!!)
                        val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                            type = "text/html"
                            putExtra(android.content.Intent.EXTRA_STREAM, uri)
                            addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            clipData = android.content.ClipData.newRawUri("Generated application", uri)
                        }
                        startActivity(android.content.Intent.createChooser(send, getString(R.string.viewer_share_chooser)))
                    }
                }.show()
        })
        layout.addView(bar)
        layout.addView(android.view.View(this).apply { setBackgroundColor(c.line) }, LinearLayout.LayoutParams(-1, maxOf(1, px(1) / 2)))
        palette = c
        setContentView(layout)
        val backCallback = object : OnBackPressedCallback(false) {
            override fun handleOnBackPressed() {
                if (showingCode) {
                    showingCode = false
                    isEnabled = false
                    paintSeg()
                    show(layout)
                }
            }
        }
        onBackPressedDispatcher.addCallback(this, backCallback)
        segViews.forEachIndexed { i, v ->
            v.setOnClickListener {
                val code = i == 1
                if (code != showingCode) {
                    showingCode = code
                    backCallback.isEnabled = showingCode
                    paintSeg()
                    show(layout)
                }
            }
        }
        show(layout)
        timer.postDelayed(stop, 10 * 60 * 1000L)
    }
    @SuppressLint("SetJavaScriptEnabled")
    private fun show(layout: LinearLayout) {
        dispose()
        while (layout.childCount > 2) layout.removeViewAt(2)
        if (showingCode) {
            val scroll = android.widget.ScrollView(this)
            val c = palette ?: Palette(false)
            val pad = (16 * resources.displayMetrics.density).toInt()
            scroll.setBackgroundColor(c.bg)
            scroll.addView(TextView(this).apply { text = html; setTextIsSelectable(true); setPadding(pad, pad, pad, pad); typeface = android.graphics.Typeface.MONOSPACE; textSize = 12.5f; setTextColor(c.fg); setLineSpacing(0f, 1.25f) })
            layout.addView(scroll, LinearLayout.LayoutParams(-1,0,1f))
            return
        }
        val view = WebView(this)
        web = view
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mediaPlaybackRequiresUserGesture = true
            cacheMode = WebSettings.LOAD_NO_CACHE
            setGeolocationEnabled(false)
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        view.webChromeClient = object : WebChromeClient() {
            override fun onJsAlert(v: WebView?, url: String?, message: String?, result: JsResult?): Boolean { result?.cancel(); return true }
            override fun onJsConfirm(v: WebView?, url: String?, message: String?, result: JsResult?): Boolean { result?.cancel(); return true }
            override fun onJsPrompt(v: WebView?, url: String?, message: String?, defaultValue: String?, result: JsPromptResult?): Boolean { result?.cancel(); return true }
            override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
            override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback?) { callback?.invoke(origin, false, false) }
            override fun onShowFileChooser(w: WebView?, callback: android.webkit.ValueCallback<Array<android.net.Uri>>?, params: FileChooserParams?): Boolean { callback?.onReceiveValue(null); return true }
        }
        view.webViewClient = GeneratedAppWebClient(html) { dispose(); finish() }
        view.setDownloadListener { _,_,_,_,_ -> }
        layout.addView(view, LinearLayout.LayoutParams(-1,0,1f))
        view.loadUrl(URL)
    }
    private fun dispose() { web?.let { it.stopLoading(); (it.parent as? android.view.ViewGroup)?.removeView(it); it.destroy() }; web = null }
    override fun onDestroy() { timer.removeCallbacks(stop); dispose(); super.onDestroy() }
    companion object {
        /** Intercepting client kept top-level-in-file for unit tests (no live WebView needed). */
        const val URL = "https://genui.invalid/app"
        /** Public JS/CSS CDNs generated apps may load libraries from (read-only GETs, no cookies). */
        val CDN_HOSTS = setOf("cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com", "esm.sh", "cdn.tailwindcss.com", "fonts.googleapis.com", "fonts.gstatic.com")
        private const val CDN = "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://esm.sh https://cdn.tailwindcss.com"
        /** No connect-src to arbitrary hosts: apps can fetch library modules from the CDNs only. */
        const val CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: $CDN; style-src 'unsafe-inline' $CDN https://fonts.googleapis.com; img-src data: blob:; media-src data: blob:; font-src data: https://fonts.gstatic.com $CDN; connect-src $CDN; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

        /** A subresource the WebView may fetch itself: https GET to an allowlisted CDN on the default port. */
        fun cdnAllowed(method: String?, url: android.net.Uri?): Boolean {
            if (method != "GET" || url == null) return false
            if (url.scheme != "https" || url.userInfo != null) return false
            if (url.port != -1 && url.port != 443) return false
            return (url.host ?: "").lowercase() in CDN_HOSTS
        }
    }
}

/** Serves only the offline app origin; blocks every other request natively. */
internal class GeneratedAppWebClient(private val html: String, private val onGone: () -> Unit = {}) : WebViewClient() {
    override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean = true
    override fun shouldInterceptRequest(v: WebView, r: WebResourceRequest): WebResourceResponse? {
        // Libraries from public CDNs load normally (the app has no cookies, bridge or storage).
        if (!r.isForMainFrame && GeneratedAppActivity.cdnAllowed(r.method, r.url)) return null
        if (r.isForMainFrame && r.url.toString() == GeneratedAppActivity.URL && r.method == "GET") {
            return WebResourceResponse("text/html", "UTF-8", 200, "OK", mapOf(
                "Content-Security-Policy" to GeneratedAppActivity.CSP,
                "Cache-Control" to "no-store",
                "X-Content-Type-Options" to "nosniff",
                "Referrer-Policy" to "no-referrer",
                "Permissions-Policy" to "camera=(), microphone=(), geolocation=(), payment=()"
            ), ByteArrayInputStream(html.toByteArray(Charsets.UTF_8)))
        }
        return WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }
    override fun onRenderProcessGone(v: WebView, detail: RenderProcessGoneDetail): Boolean { onGone(); return true }
}
