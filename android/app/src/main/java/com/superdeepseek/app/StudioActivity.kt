package com.superdeepseek.app

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.PopupMenu
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File
import java.io.OutputStream
import org.json.JSONObject

/**
 * Linux Studio: the user's window into the sandbox.
 *
 *  - Terminal  a shell in the sandbox; the agent's commands and their output
 *              are mirrored here live, so the user can watch it work.
 *  - Files     browse /root/workspace, open, preview, ask the AI about a
 *              file, save to the phone, share, import, delete.
 *  - Preview   web apps served from the sandbox (http://127.0.0.1:<port>),
 *              found automatically, and HTML / Markdown / image files from
 *              the workspace (see [StudioPreview]).
 *
 * Built in code (no layouts), following the chat's light/dark theme.
 */
class StudioActivity : ComponentActivity(), Sandbox.Listener {

    companion object {
        const val EXTRA_PREVIEW_URL = "preview_url"
        private const val MAX_TERMINAL_CHARS = 200_000

        fun start(context: Context, previewUrl: String? = null) {
            val i = Intent(context, StudioActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            if (previewUrl != null) i.putExtra(EXTRA_PREVIEW_URL, previewUrl)
            if (context !is android.app.Activity) i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(i)
        }

        /** Set by the chat: puts text into its message box (Studio's "Ask the AI"). */
        @Volatile var onAskAi: ((String) -> Unit)? = null

        /** Ports web dev servers usually listen on; probed for the Preview start page. */
        private val COMMON_PORTS = intArrayOf(3000, 3001, 4000, 4173, 4200, 5000, 5173, 5500, 8000, 8001, 8080, 8081, 8088, 8888, 9000)

        /** True while a Studio window is visible (the preview tool reports it). */
        @Volatile var visible = false
            private set
    }

    private val sandbox by lazy { Sandbox.get(this) }
    private val main = Handler(Looper.getMainLooper())
    private val prefs by lazy { getSharedPreferences(WebViewBridge.PREFS_NAME, MODE_PRIVATE) }

    // Theme
    private var dark = true
    private var cBg = 0; private var cSurface = 0; private var cText = 0; private var cMuted = 0
    private var cAccent = 0; private var cLine = 0; private var cAgent = 0; private var cError = 0

    private lateinit var subtitle: TextView
    private lateinit var tabs: List<TextView>
    private lateinit var pages: List<View>
    private var currentTab = 0

    // Terminal
    private lateinit var termScroll: ScrollView
    private lateinit var termText: TextView
    private lateinit var termInput: EditText
    private val termBuffer = SpannableStringBuilder()
    @Volatile private var shell: Process? = null
    /** A shell is being started; commands typed meanwhile wait in [waitingForShell]. */
    private var shellStarting = false
    private val waitingForShell = ArrayList<(Process) -> Unit>()
    /** One writer thread, so commands reach the shell in the order they were typed. */
    private val shellWriter = java.util.concurrent.Executors.newSingleThreadExecutor()
    private val history = ArrayList<String>()
    private var historyIndex = 0
    private lateinit var runButton: ImageButton
    /** A typed command is running in the shell (its input goes to that program). */
    private var running = false
    /** Where the shell is (from the last finished command): a restarted shell opens here. */
    private var shellCwd = Sandbox.WORKSPACE

    // Files
    private lateinit var filesPath: TextView
    private lateinit var filesList: ListView
    private lateinit var filesEmpty: TextView
    private var cwd = Sandbox.WORKSPACE
    private var entries: List<File> = emptyList()

    // Preview
    private lateinit var previewUrl: EditText
    private lateinit var previewWeb: WebView
    private lateinit var previewHome: ScrollView
    private lateinit var previewHomeList: LinearLayout
    private lateinit var previewExternal: ImageButton
    private var previewFailed = false
    /** A page has been opened in the preview (the start page is not shown). */
    private var previewOpened = false
    /** Bumps on every start-page refresh, so a slow scan never overwrites a newer one. */
    private var homeGeneration = 0

    private val importLauncher = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (!uris.isNullOrEmpty()) importFiles(uris)
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        resolveColors()
        WindowCompat.setDecorFitsSystemWindows(window, false)
        @Suppress("DEPRECATION")
        run {
            window.statusBarColor = cBg
            window.navigationBarColor = cBg
        }
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
        setContentView(buildUi())
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (stepBack()) return
                isEnabled = false
                onBackPressedDispatcher.onBackPressed()
                isEnabled = true
            }
        })
        sandbox.addListener(this)
        refreshStatus()
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        visible = true
        if (currentTab == 1) loadDir(cwd)
    }

    override fun onPause() {
        visible = false
        super.onPause()
    }

    override fun onDestroy() {
        activeSheet?.dismiss(animated = false)
        sandbox.removeListener(this)
        shell?.let { p -> Thread { runCatching { p.destroy() } }.start() }
        shell = null
        waitingForShell.clear()
        shellWriter.shutdown()
        runCatching { previewWeb.destroy() }
        super.onDestroy()
    }

    /** Back inside Studio first: the preview's own history, then the folder above. */
    private fun stepBack(): Boolean = when (currentTab) {
        2 -> if (!previewOpened) false else {
            if (previewWeb.canGoBack()) previewWeb.goBack()
            else {
                previewOpened = false
                previewWeb.loadUrl("about:blank")
                previewUrl.setText("")
                showPreviewHome(null)
            }
            true
        }
        1 -> if (cwd == Sandbox.WORKSPACE || cwd == "/") false else {
            loadDir(cwd.substringBeforeLast('/').ifEmpty { "/" })
            true
        }
        else -> false
    }

    private fun handleIntent(intent: Intent?) {
        val url = intent?.getStringExtra(EXTRA_PREVIEW_URL) ?: return
        intent.removeExtra(EXTRA_PREVIEW_URL)
        selectTab(2)
        openPreview(url)
    }

    // ── Theme ────────────────────────────────────────────────────────────────

    private fun resolveColors() {
        val stored = prefs.getString(WebViewBridge.KEY_LAST_PAGE_DARK, null)
        dark = stored?.let { it == "true" }
                ?: ((resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES)
        if (dark) {
            cBg = 0xFF1E1F23.toInt(); cSurface = 0xFF2A2B31.toInt(); cText = 0xFFECECF1.toInt()
            cMuted = 0xFF9A9BA6.toInt(); cLine = 0x1FFFFFFF; cAgent = 0xFF8AB4FF.toInt(); cError = 0xFFFF8A80.toInt()
        } else {
            cBg = 0xFFFFFFFF.toInt(); cSurface = 0xFFF3F4F6.toInt(); cText = 0xFF1F1F23.toInt()
            cMuted = 0xFF6B6C75.toInt(); cLine = 0x1F000000; cAgent = 0xFF3957E0.toInt(); cError = 0xFFD93025.toInt()
        }
        cAccent = 0xFF4D6BFE.toInt()
    }

    private fun dp(v: Float): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt()
    private fun dp(v: Int): Int = dp(v.toFloat())

    private fun rounded(color: Int, radius: Float, stroke: Int = 0): GradientDrawable = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(radius).toFloat()
        if (stroke != 0) setStroke(dp(1), stroke)
    }

    private fun iconButton(icon: Int, desc: String, onClick: (View) -> Unit): ImageButton = ImageButton(this).apply {
        setImageResource(icon)
        imageTintList = ColorStateList.valueOf(cText)
        contentDescription = desc
        background = rounded(Color.TRANSPARENT, 20f)
        val v = TypedValue()
        if (theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, v, true)) setBackgroundResource(v.resourceId)
        setPadding(dp(10), dp(10), dp(10), dp(10))
        layoutParams = LinearLayout.LayoutParams(dp(44), dp(44))
        setOnClickListener(onClick)
    }

    private fun label(text: String, size: Float, color: Int, bold: Boolean = false): TextView = TextView(this).apply {
        this.text = text
        setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
        setTextColor(color)
        if (bold) typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    }

    /** The app's language (the chat's own setting, shared by the page), else the phone's. */
    private val bnUi: Boolean by lazy {
        val app = prefs.getString(WebViewBridge.KEY_UI_LOCALE, null).orEmpty()
        if (app.isNotEmpty()) app.lowercase(java.util.Locale.ROOT).startsWith("bn")
        else resources.configuration.locales[0].language == "bn"
    }
    private fun bn(): Boolean = bnUi
    private fun t(en: String, bnText: String) = if (bn()) bnText else en

    // ── Layout ───────────────────────────────────────────────────────────────

    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(cBg)
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        // Top bar
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(4), dp(4), dp(4), dp(4))
        }
        bar.addView(iconButton(R.drawable.ic_studio_back, t("Back", "ফিরে যান")) { finish() })
        val titles = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(4) }
        }
        titles.addView(label("Linux Studio", 17f, cText, bold = true))
        subtitle = label("", 12f, cMuted)
        titles.addView(subtitle)
        bar.addView(titles)
        bar.addView(iconButton(R.drawable.ic_studio_stop, t("Stop everything", "সব থামান")) { stopAll() })
        bar.addView(iconButton(R.drawable.ic_studio_more, t("More", "আরও")) { showMenu(it) })
        root.addView(bar)

        // Tabs
        val tabRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            background = rounded(cSurface, 12f)
            setPadding(dp(3), dp(3), dp(3), dp(3))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                setMargins(dp(12), dp(2), dp(12), dp(8))
            }
        }
        tabs = listOf(t("Terminal", "টার্মিনাল"), t("Files", "ফাইল"), t("Preview", "প্রিভিউ")).mapIndexed { i, name ->
            label(name, 14f, cMuted, bold = true).apply {
                gravity = Gravity.CENTER
                setPadding(0, dp(8), 0, dp(8))
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                setOnClickListener { selectTab(i) }
            }.also { tabRow.addView(it) }
        }
        root.addView(tabRow)

        val content = FrameLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        }
        pages = listOf(buildTerminal(), buildFiles(), buildPreview())
        pages.forEach { content.addView(it, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)) }
        root.addView(content)
        selectTab(0)
        return root
    }

    private fun selectTab(i: Int) {
        currentTab = i
        tabs.forEachIndexed { k, tv ->
            tv.setTextColor(if (k == i) cText else cMuted)
            tv.background = if (k == i) rounded(cBg, 10f) else null
        }
        pages.forEachIndexed { k, v -> v.visibility = if (k == i) View.VISIBLE else View.GONE }
        if (i == 1) loadDir(cwd)
        if (i == 2 && !previewOpened) showPreviewHome(null)
    }

    private fun showMenu(anchor: View) {
        val menu = PopupMenu(this, anchor)
        val enabled = prefs.getString(WebViewBridge.KEY_SANDBOX_ENABLED, "1") != "0"
        val ask = prefs.getString(WebViewBridge.KEY_SANDBOX_MODE, "auto") == "ask"
        menu.menu.add(0, 1, 0, t("Sandbox for the AI", "AI-এর জন্য স্যান্ডবক্স")).apply { isCheckable = true; isChecked = enabled }
        menu.menu.add(0, 2, 1, t("Ask before each command", "প্রতিটি কমান্ডের আগে জিজ্ঞেস করুন")).apply { isCheckable = true; isChecked = ask }
        val keepGoing = prefs.getString(WebViewBridge.KEY_AGENT_CONTINUE, "1") != "0"
        menu.menu.add(0, 4, 2, t("Keep going until the task is done", "কাজ শেষ না হওয়া পর্যন্ত চালিয়ে যাক")).apply { isCheckable = true; isChecked = keepGoing }
        menu.menu.add(0, 3, 3, t("Reset Linux (deletes all files)…", "লিনাক্স রিসেট (সব ফাইল মুছে যাবে)…"))
        menu.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                1 -> prefs.edit().putString(WebViewBridge.KEY_SANDBOX_ENABLED, if (enabled) "0" else "1").apply()
                2 -> prefs.edit().putString(WebViewBridge.KEY_SANDBOX_MODE, if (ask) "auto" else "ask").apply()
                3 -> confirmReset()
                4 -> prefs.edit().putString(WebViewBridge.KEY_AGENT_CONTINUE, if (keepGoing) "0" else "1").apply()
            }
            refreshStatus()
            true
        }
        menu.show()
    }

    private fun confirmReset() {
        AlertDialog.Builder(this)
                .setTitle(t("Reset Linux?", "লিনাক্স রিসেট করবেন?"))
                .setMessage(t("This deletes the Linux system, installed packages and everything in the workspace. It is downloaded again on next use.",
                        "এতে লিনাক্স সিস্টেম, ইনস্টল করা প্যাকেজ এবং ওয়ার্কস্পেসের সব ফাইল মুছে যাবে। পরের বার ব্যবহারের সময় আবার ডাউনলোড হবে।"))
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(t("Reset", "রিসেট")) { _, _ ->
                    interruptShell()
                    shellCwd = Sandbox.WORKSPACE
                    updateRunUi()
                    Thread {
                        sandbox.reset()
                        main.post {
                            termBuffer.clear(); termText.text = ""
                            refreshStatus(); loadDir(Sandbox.WORKSPACE)
                        }
                    }.start()
                }
                .show()
    }

    private fun stopAll() {
        Thread { sandbox.killAll() }.start()
        SandboxService.onStopRequested?.invoke()
        restartShellSoon()
        toast(t("Stopped all sandbox processes", "স্যান্ডবক্সের সব প্রসেস থামানো হয়েছে"))
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()

    private fun refreshStatus() {
        val s = runCatching { sandbox.status() }.getOrNull() ?: return
        val enabled = prefs.getString(WebViewBridge.KEY_SANDBOX_ENABLED, "1") != "0"
        subtitle.text = when {
            !s.optBoolean("supported") -> s.optString("reason")
            s.optBoolean("installing") -> t("Setting up Linux… ", "লিনাক্স প্রস্তুত হচ্ছে… ") + "${(s.optDouble("progress") * 100).toInt()}%"
            !s.optBoolean("installed") -> t("Not set up yet — run a command to start", "এখনও প্রস্তুত নয় — শুরু করতে একটি কমান্ড চালান")
            else -> "Alpine ${s.optString("version")} · ${s.optString("abi")}" +
                    (if (s.optInt("active") > 0) " · " + t("${s.optInt("active")} running", "${s.optInt("active")}টি চলছে") else "") +
                    (if (!enabled) " · " + t("AI access off", "AI অ্যাক্সেস বন্ধ") else "")
        }
    }

    // ── Sandbox events ───────────────────────────────────────────────────────

    override fun onSandboxEvent(event: JSONObject) {
        main.post {
            if (isDestroyed) return@post
            when (event.optString("type")) {
                "install" -> refreshStatus()
                "reset" -> {
                    // Reset from Settings (or this screen): nothing of the old system is left.
                    interruptShell()
                    shellCwd = Sandbox.WORKSPACE
                    termBuffer.clear(); termText.text = ""
                    refreshStatus(); loadDir(Sandbox.WORKSPACE)
                }
                "file" -> {
                    val path = event.optString("path")
                    appendTerm("\n✎ AI  " + t("wrote ", "লিখেছে ") + path + " (" + humanSize(event.optLong("bytes")) + ")\n", cAgent)
                    onFileChanged(path)
                }
                "exec" -> when (event.optString("phase")) {
                    "start" -> {
                        // Just the command; the folder only when it is not the workspace.
                        val dir = event.optString("cwd")
                        val where = if (dir.isEmpty() || dir == Sandbox.WORKSPACE) "" else "   · " + dir.removePrefix(Sandbox.WORKSPACE + "/")
                        appendTerm("\n● AI  " + event.optString("command") + where + "\n", cAgent)
                    }
                    "output" -> appendTerm(Sandbox.stripAnsi(event.optString("text")), cMuted)
                    "end" -> {
                        val code = event.optInt("exitCode")
                        appendTerm(if (event.optBoolean("timedOut")) "[timed out]\n" else "[exit $code]\n", if (code == 0) cAgent else cError)
                        if (currentTab == 1) loadDir(cwd)
                    }
                }
            }
        }
    }

    override fun onActiveCountChanged(active: Int) {
        main.post { if (!isDestroyed) refreshStatus() }
    }

    // ── Terminal ─────────────────────────────────────────────────────────────

    /** JetBrains Mono (OFL, bundled): some phones map "monospace" to a typewriter serif. */
    private val mono: Typeface by lazy {
        runCatching { androidx.core.content.res.ResourcesCompat.getFont(this, R.font.sd_mono) }.getOrNull() ?: Typeface.MONOSPACE
    }

    private fun buildTerminal(): View {
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        termText = TextView(this).apply {
            typeface = mono
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
            setTextColor(cText)
            setTextIsSelectable(true)
            setPadding(dp(16), dp(8), dp(16), dp(12))
            setLineSpacing(0f, 1.18f)
        }
        termScroll = ScrollView(this).apply {
            isFillViewport = true
            isVerticalScrollBarEnabled = false
            addView(termText)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        }
        box.addView(termScroll)
        appendTerm(t("Linux sandbox terminal. The AI's commands appear here too.\nType a command below — e.g. ls, python3 app.py, apk add nodejs.\n\n",
                "লিনাক্স স্যান্ডবক্স টার্মিনাল। AI-এর কমান্ডও এখানে দেখা যাবে।\nনিচে কমান্ড লিখুন — যেমন ls, python3 app.py, apk add nodejs।\n\n"), cMuted)

        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = rounded(cSurface, 22f)
            setPadding(dp(18), dp(2), dp(4), dp(2))
            minimumHeight = dp(48)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                setMargins(dp(12), dp(6), dp(12), dp(10))
            }
        }
        termInput = EditText(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setTextColor(cText)
            setHintTextColor(cMuted)
            background = null
            isSingleLine = true
            setPadding(0, dp(10), 0, dp(10))
            imeOptions = EditorInfo.IME_ACTION_SEND or EditorInfo.IME_FLAG_NO_EXTRACT_UI
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or
                    android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
            // After inputType: a password variation resets the typeface to the
            // system monospace (the typewriter serif on some phones).
            typeface = mono
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            setOnEditorActionListener { _, action, ev ->
                if (action == EditorInfo.IME_ACTION_SEND || (ev?.keyCode == KeyEvent.KEYCODE_ENTER && ev.action == KeyEvent.ACTION_DOWN)) {
                    submitCommand(); true
                } else false
            }
            // A hardware keyboard's arrows walk the history.
            setOnKeyListener { _, code, ev ->
                if (ev.action != KeyEvent.ACTION_DOWN) return@setOnKeyListener false
                when (code) {
                    KeyEvent.KEYCODE_DPAD_UP -> { recall(-1); true }
                    KeyEvent.KEYCODE_DPAD_DOWN -> { recall(1); true }
                    else -> false
                }
            }
        }
        row.addView(termInput)
        // One button that does what makes sense now: Run, or Stop while a
        // command is running. A long press lists recent commands.
        runButton = iconButton(R.drawable.ic_studio_send, t("Run", "চালান")) {
            if (running) stopCommand() else submitCommand()
        }.apply {
            setOnLongClickListener { showHistory(it); true }
        }
        row.addView(runButton)
        box.addView(row)
        updateRunUi()
        return box
    }

    /** The Run/Stop button and the hint follow the shell's state. */
    private fun updateRunUi() {
        if (!::runButton.isInitialized) return
        runButton.setImageResource(if (running) R.drawable.ic_studio_stop else R.drawable.ic_studio_send)
        runButton.imageTintList = ColorStateList.valueOf(if (running) cError else cAccent)
        runButton.contentDescription = if (running) t("Stop the running command", "চলমান কমান্ড থামান") else t("Run", "চালান")
        termInput.hint = if (running) t("input for the running program", "চলমান প্রোগ্রামের ইনপুট") else t("command", "কমান্ড")
    }

    private fun showHistory(anchor: View) {
        val recent = history.asReversed().distinct().take(12)
        if (recent.isEmpty()) { toast(t("No commands yet", "এখনও কোনো কমান্ড নেই")); return }
        val menu = PopupMenu(this, anchor)
        recent.forEachIndexed { i, c -> menu.menu.add(0, i, i, c) }
        menu.setOnMenuItemClickListener { item ->
            val v = recent[item.itemId]
            termInput.setText(v)
            termInput.setSelection(v.length)
            termInput.requestFocus()
            true
        }
        menu.show()
    }

    private fun recall(dir: Int) {
        if (history.isEmpty()) return
        historyIndex = (historyIndex + dir).coerceIn(0, history.size)
        val v = if (historyIndex >= history.size) "" else history[historyIndex]
        termInput.setText(v)
        termInput.setSelection(v.length)
    }

    private fun appendTerm(text: String, color: Int) {
        if (text.isEmpty()) return
        val start = termBuffer.length
        termBuffer.append(text)
        if (color != cText) termBuffer.setSpan(ForegroundColorSpan(color), start, termBuffer.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        trimAndShow(color == cAgent)
    }

    /** "$ command" with the prompt sign in the accent colour. */
    private fun appendCommandEcho(cmd: String) {
        if (termBuffer.isNotEmpty() && termBuffer[termBuffer.length - 1] != '\n') termBuffer.append('\n')
        val start = termBuffer.length
        termBuffer.append("$ ")
        termBuffer.setSpan(ForegroundColorSpan(cAccent), start, start + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        termBuffer.setSpan(android.text.style.StyleSpan(Typeface.BOLD), start, termBuffer.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        val cmdStart = termBuffer.length
        termBuffer.append(cmd).append('\n')
        termBuffer.setSpan(android.text.style.StyleSpan(Typeface.BOLD), cmdStart, termBuffer.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        trimAndShow(true)
    }

    private var showPending = false
    private var showForceScroll = false
    private val showTerm = Runnable {
        showPending = false
        if (isDestroyed) return@Runnable
        if (termBuffer.length > MAX_TERMINAL_CHARS) termBuffer.delete(0, termBuffer.length - MAX_TERMINAL_CHARS * 3 / 4)
        val atBottom = !termScroll.canScrollVertically(1)
        termText.text = termBuffer
        if (atBottom || showForceScroll) termScroll.post { termScroll.fullScroll(View.FOCUS_DOWN) }
        showForceScroll = false
    }

    /**
     * Shows the buffer at most once a frame: a chatty build prints many
     * chunks per frame, and re-laying out 200k characters for each one made
     * the terminal stutter.
     */
    private fun trimAndShow(forceScroll: Boolean) {
        showForceScroll = showForceScroll || forceScroll
        if (showPending) return
        showPending = true
        termText.postOnAnimation(showTerm)
    }

    private fun submitCommand() {
        val cmd = termInput.text.toString()
        termInput.setText("")
        if (running) {
            // The running program's input (e.g. answering a y/n question).
            appendTerm(cmd + "\n", cMuted)
            val line = cmd + "\n"
            if (shellStarting) waitingForShell.add { writeToShell(it, line) }
            else shell?.let { p -> runOnShellWriter(p) { writeToShell(it, line) } }
            return
        }
        if (cmd.isBlank()) return
        if (history.lastOrNull() != cmd) history.add(cmd)
        historyIndex = history.size
        when (cmd.trim()) {
            "clear" -> { termBuffer.clear(); termText.text = ""; return }
            "exit" -> { interruptShell(); return }
        }
        appendCommandEcho(cmd)
        running = true
        updateRunUi()
        ensureShell { p -> writeToShell(p, ShellProtocol.wrap(cmd)) }
    }

    private fun writeToShell(p: Process, text: String) {
        runCatching {
            p.outputStream.write(text.toByteArray())
            p.outputStream.flush()
        }.onFailure {
            if (shell === p) shell = null
            main.post {
                if (isDestroyed) return@post
                appendTerm(t("[shell closed — run the command again]\n", "[শেল বন্ধ হয়ে গেছে — কমান্ডটি আবার চালান]\n"), cError)
                running = false
                updateRunUi()
            }
        }
    }

    private fun onShellEvent(ev: ShellProtocol.Event) {
        when (ev) {
            is ShellProtocol.Event.Text -> {
                val s = ShellProtocol.stripNoise(Sandbox.stripAnsi(ev.text))
                appendTerm(s, cText)
            }
            is ShellProtocol.Event.Done -> {
                if (termBuffer.isNotEmpty() && termBuffer[termBuffer.length - 1] != '\n') appendTerm("\n", cText)
                if (ev.exitCode != 0) appendTerm(t("exit ${ev.exitCode}\n", "এক্সিট ${ev.exitCode}\n"), cError)
                shellCwd = ev.cwd
                running = false
                updateRunUi()
            }
        }
    }

    private fun runOnShellWriter(p: Process, then: (Process) -> Unit) {
        runCatching { shellWriter.execute { then(p) } }
    }

    private fun ensureShell(then: (Process) -> Unit) {
        shell?.takeIf { it.isAliveCompat() }?.let { p -> runOnShellWriter(p, then); return }
        // Two quick commands must not start two shells: queue behind the one starting.
        if (shellStarting) { waitingForShell.add(then); return }
        if (!sandbox.isSupported()) {
            appendTerm(sandbox.unsupportedReason() + "\n", cError)
            running = false
            updateRunUi()
            return
        }
        if (!sandbox.isInstalled()) appendTerm(t("Setting up Linux (one-time download, about 4 MB)…\n", "লিনাক্স প্রস্তুত হচ্ছে (একবারের ডাউনলোড, প্রায় ৪ MB)…\n"), cMuted)
        shellStarting = true
        waitingForShell.add(then)
        val startIn = shellCwd
        Thread {
            try {
                val p = sandbox.startShell(startIn)
                shell = p
                Thread({
                    val buf = ByteArray(8192)
                    val decoder = Utf8Chunker()
                    val parser = ShellProtocol.Parser()
                    try {
                        p.inputStream.use { input ->
                            while (true) {
                                val n = input.read(buf)
                                if (n < 0) break
                                val events = parser.feed(decoder.decode(buf, n))
                                if (events.isNotEmpty()) main.post { if (!isDestroyed && shell === p) events.forEach { onShellEvent(it) } }
                            }
                        }
                    } catch (_: Exception) {}
                    if (shell === p) {
                        // Ended by itself (not Stop): say so, so a failure is never silent.
                        shell = null
                        val code = runCatching { p.waitFor() }.getOrNull()
                        main.post {
                            if (isDestroyed) return@post
                            appendTerm(t("[shell exited", "[শেল বন্ধ হয়েছে") + (code?.let { " · $it" } ?: "") + "]\n", cMuted)
                            running = false
                            updateRunUi()
                        }
                    }
                }, "studio-shell").start()
                main.post {
                    shellStarting = false
                    val queued = ArrayList(waitingForShell)
                    waitingForShell.clear()
                    queued.forEach { runOnShellWriter(p, it) }
                    refreshStatus()
                }
            } catch (e: Exception) {
                main.post {
                    shellStarting = false
                    waitingForShell.clear()
                    appendTerm((e.message ?: "Could not start the shell") + "\n", cError)
                    running = false
                    updateRunUi()
                    refreshStatus()
                }
            }
        }.start()
    }

    private fun Process.isAliveCompat(): Boolean = runCatching { exitValue(); false }.getOrDefault(true)

    /** Stop: ends the shell and whatever runs in it; the next command starts a fresh one in the same folder. */
    private fun stopCommand() {
        interruptShell()
        appendTerm(t("stopped\n", "থামানো হয়েছে\n"), cMuted)
    }

    private fun interruptShell() {
        val p = shell
        shell = null
        waitingForShell.clear()
        if (p != null) Thread { runCatching { p.destroy() } }.start()
        if (running) {
            running = false
            updateRunUi()
        }
    }

    private fun restartShellSoon() {
        if (shell != null || running) interruptShell()
    }

    // ── Files ────────────────────────────────────────────────────────────────

    private fun buildFiles(): View {
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = rounded(cSurface, 22f)
            setPadding(dp(2), 0, dp(2), 0)
            minimumHeight = dp(48)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                setMargins(dp(12), 0, dp(12), dp(4))
            }
        }
        bar.addView(iconButton(R.drawable.ic_studio_up, t("Up", "উপরে")) {
            if (cwd != "/") loadDir(cwd.substringBeforeLast('/').ifEmpty { "/" })
        })
        filesPath = label(cwd, 13f, cMuted).apply {
            typeface = mono
            isSingleLine = true
            ellipsize = android.text.TextUtils.TruncateAt.START
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        bar.addView(filesPath)
        bar.addView(iconButton(R.drawable.ic_studio_upload, t("Import files from the phone", "ফোন থেকে ফাইল আনুন")) {
            runCatching { importLauncher.launch(arrayOf("*/*")) }
        })
        bar.addView(iconButton(R.drawable.ic_studio_refresh, t("Refresh", "রিফ্রেশ")) { loadDir(cwd) })
        box.addView(bar)

        val frame = FrameLayout(this).apply { layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f) }
        filesList = ListView(this).apply {
            divider = null
            adapter = filesAdapter
            setOnItemClickListener { _, _, pos, _ -> openEntry(entries[pos]) }
            setOnItemLongClickListener { _, _, pos, _ -> entryMenu(entries[pos]); true }
        }
        filesEmpty = label("", 14f, cMuted).apply {
            gravity = Gravity.CENTER
            setPadding(dp(24), dp(24), dp(24), dp(24))
        }
        frame.addView(filesList)
        frame.addView(filesEmpty, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        box.addView(frame)
        return box
    }

    private val filesAdapter = object : BaseAdapter() {
        override fun getCount() = entries.size
        override fun getItem(position: Int) = entries[position]
        override fun getItemId(position: Int) = position.toLong()
        override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
            val f = entries[position]
            val row = (convertView as? LinearLayout) ?: newFileRow()
            val link = runCatching { java.nio.file.Files.isSymbolicLink(f.toPath()) }.getOrDefault(false)
            val dir = f.isDirectory
            (row.getChildAt(0) as android.widget.ImageView).apply {
                setImageResource(when { link -> R.drawable.ic_studio_link; dir -> R.drawable.ic_studio_folder; else -> R.drawable.ic_studio_file })
                imageTintList = ColorStateList.valueOf(if (dir && !link) cAccent else cMuted)
            }
            val texts = row.getChildAt(1) as LinearLayout
            (texts.getChildAt(0) as TextView).text = f.name
            val modified = f.lastModified()
            val ago = if (modified > 0) android.text.format.DateUtils.getRelativeTimeSpanString(
                    modified, System.currentTimeMillis(), android.text.format.DateUtils.MINUTE_IN_MILLIS,
                    android.text.format.DateUtils.FORMAT_ABBREV_RELATIVE).toString() else ""
            (texts.getChildAt(1) as TextView).text = if (dir) ago else listOf(humanSize(f.length()), ago).filter { it.isNotEmpty() }.joinToString(" · ")
            return row
        }
    }

    private fun newFileRow(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        minimumHeight = dp(56)
        setPadding(dp(16), dp(8), dp(16), dp(8))
        val v = TypedValue()
        if (theme.resolveAttribute(android.R.attr.selectableItemBackground, v, true)) setBackgroundResource(v.resourceId)
        addView(android.widget.ImageView(this@StudioActivity).apply {
            background = rounded(cSurface, 10f)
            setPadding(dp(8), dp(8), dp(8), dp(8))
            layoutParams = LinearLayout.LayoutParams(dp(38), dp(38))
        })
        addView(LinearLayout(this@StudioActivity).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(14) }
            addView(label("", 14.5f, cText).apply {
                isSingleLine = true
                ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
            })
            addView(label("", 12f, cMuted).apply { isSingleLine = true })
        })
    }

    private fun humanSize(n: Long): String = when {
        n < 1024 -> "$n B"
        n < 1024 * 1024 -> "${n / 1024} KB"
        else -> "%.1f MB".format(java.util.Locale.US, n / (1024.0 * 1024.0))
    }

    private fun loadDir(path: String) {
        if (!::filesList.isInitialized) return
        if (!sandbox.isInstalled()) {
            entries = emptyList()
            filesAdapter.notifyDataSetChanged()
            filesEmpty.text = t("Linux is not set up yet. Run a command in the Terminal (or let the AI use it) to set it up.",
                    "লিনাক্স এখনও প্রস্তুত নয়। প্রস্তুত করতে টার্মিনালে একটি কমান্ড চালান (বা AI-কে ব্যবহার করতে দিন)।")
            filesEmpty.visibility = View.VISIBLE
            return
        }
        val dir = sandbox.hostFile(path)
        if (dir == null || !dir.isDirectory) {
            toast(t("Can't open $path", "$path খোলা যাচ্ছে না"))
            if (path != Sandbox.WORKSPACE) loadDir(Sandbox.WORKSPACE)
            return
        }
        cwd = path
        filesPath.text = path
        entries = (dir.listFiles()?.toList() ?: emptyList())
                .sortedWith(compareBy<File>({ !it.isDirectory }, { it.name.lowercase() }))
        filesAdapter.notifyDataSetChanged()
        filesEmpty.text = t("Empty folder", "ফাঁকা ফোল্ডার")
        filesEmpty.visibility = if (entries.isEmpty()) View.VISIBLE else View.GONE
    }

    private fun guestOf(f: File): String = (if (cwd == "/") "" else cwd) + "/" + f.name

    private var activeSheet: StudioSheet? = null

    private fun newSheet(): StudioSheet {
        activeSheet?.dismiss(animated = false)
        return StudioSheet(this, dark, cBg, cText, cMuted).also { sh ->
            activeSheet = sh
            sh.onDismissed = { if (activeSheet === sh) activeSheet = null }
        }
    }

    /** A round icon button for a sheet's title row. */
    private fun sheetIcon(icon: Int, desc: String, tint: Int = cText, onClick: () -> Unit): ImageButton =
            iconButton(icon, desc) { onClick() }.apply { imageTintList = ColorStateList.valueOf(tint) }

    private fun openEntry(f: File) {
        val guest = guestOf(f)
        if (f.isDirectory) { loadDir(guest); return }
        val sheet = newSheet()
        val actions = ArrayList<View>()
        if (StudioPreview.isPreviewable(f.name)) {
            actions.add(sheetIcon(R.drawable.ic_studio_preview, t("Preview", "প্রিভিউ"), cAccent) { sheet.dismiss(then = { previewFile(guest) }) })
        }
        actions.add(sheetIcon(R.drawable.ic_studio_ai, t("Ask the AI about this file", "এই ফাইল নিয়ে AI-কে জিজ্ঞেস করুন")) { sheet.dismiss(then = { askAi(guest) }) })
        actions.add(sheetIcon(R.drawable.ic_studio_share, t("Share", "শেয়ার")) { sheet.dismiss(then = { shareFile(guest) }) })
        actions.add(sheetIcon(R.drawable.ic_studio_download, t("Save to phone", "ফোনে সেভ")) { sheet.dismiss(then = { exportFile(guest) }) })
        sheet.header(f.name, humanSize(f.length()) + " · " + cwd, actions)

        val kind = StudioPreview.kind(f.name)
        val image = if (kind == StudioPreview.Kind.IMAGE) decodeImage(f) else null
        val bytes = if (image == null) readHead(f, 256 * 1024) else null
        val body: View = when {
            image != null -> android.widget.ImageView(this).apply {
                setImageBitmap(image)
                adjustViewBounds = true
                scaleType = android.widget.ImageView.ScaleType.FIT_CENTER
                setPadding(dp(16), dp(4), dp(16), dp(16))
                setOnClickListener { sheet.dismiss(then = { previewFile(guest) }) }
            }
            bytes == null || bytes.take(4096).any { it.toInt() == 0 } -> label(
                    t("Binary file · ${humanSize(f.length())}", "বাইনারি ফাইল · ${humanSize(f.length())}") +
                            if (StudioPreview.isPreviewable(f.name)) t("\nTap Preview to open it.", "\nখুলতে প্রিভিউ চাপুন।") else "",
                    14f, cMuted).apply { setPadding(dp(20), dp(12), dp(20), dp(24)) }
            else -> {
                val text = String(bytes, Charsets.UTF_8) + if (f.length() > bytes.size) "\n\n[… ${t("truncated", "কাটা হয়েছে")} …]" else ""
                ScrollView(this).apply {
                    isVerticalScrollBarEnabled = true
                    addView(TextView(this@StudioActivity).apply {
                        this.text = text
                        typeface = mono
                        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                        setTextColor(cText)
                        setTextIsSelectable(true)
                        setLineSpacing(0f, 1.15f)
                        setPadding(dp(16), dp(10), dp(16), dp(16))
                    })
                    background = rounded(cSurface, 14f)
                    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                        setMargins(dp(12), 0, dp(12), dp(12))
                    }
                }.also { sheet.scrollable = it }
            }
        }
        sheet.content.addView(body)
        sheet.show()
    }

    private fun readHead(f: File, max: Int): ByteArray? = runCatching {
        f.inputStream().use { s ->
            val b = ByteArray(minOf(f.length(), max.toLong()).toInt())
            var r = 0
            while (r < b.size) { val n = s.read(b, r, b.size - r); if (n < 0) break; r += n }
            b.copyOf(r)
        }
    }.getOrNull()

    /** A picture scaled down to the screen (SVG and unknown formats: null). */
    private fun decodeImage(f: File): android.graphics.Bitmap? = runCatching {
        val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeFile(f.path, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return@runCatching null
        val target = resources.displayMetrics.widthPixels.coerceAtLeast(720)
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= target || bounds.outHeight / (sample * 2) >= target * 2) sample *= 2
        android.graphics.BitmapFactory.decodeFile(f.path, android.graphics.BitmapFactory.Options().apply { inSampleSize = sample })
    }.getOrNull()

    private fun entryMenu(f: File) {
        val guest = guestOf(f)
        val dir = f.isDirectory
        val sheet = newSheet().header(f.name, if (dir) cwd else humanSize(f.length()) + " · " + cwd)
        if (dir || StudioPreview.isPreviewable(f.name)) sheet.action(R.drawable.ic_studio_preview, t("Preview", "প্রিভিউ")) { previewFile(guest) }
        sheet.action(R.drawable.ic_studio_ai, t("Ask the AI about it", "এটি নিয়ে AI-কে জিজ্ঞেস করুন")) { askAi(guest) }
        if (!dir) {
            sheet.action(R.drawable.ic_studio_share, t("Share", "শেয়ার")) { shareFile(guest) }
            sheet.action(R.drawable.ic_studio_download, t("Save to phone", "ফোনে সেভ")) { exportFile(guest) }
        }
        sheet.action(R.drawable.ic_studio_delete, t("Delete", "মুছুন"), cError) { confirmDelete(f) }
        sheet.space(8f).show()
    }

    private fun confirmDelete(f: File) {
        AlertDialog.Builder(this)
                .setMessage(t("Delete ${f.name}?", "${f.name} মুছে ফেলবেন?"))
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(t("Delete", "মুছুন")) { _, _ ->
                    // A big folder (node_modules) takes seconds: never on the main thread.
                    Thread {
                        val isLink = runCatching { java.nio.file.Files.isSymbolicLink(f.toPath()) }.getOrDefault(false)
                        if (f.isDirectory && !isLink) deleteTreeNoFollow(f) else f.delete()
                        main.post { if (!isDestroyed) loadDir(cwd) }
                    }.start()
                }.show()
    }

    /** Back to the chat with the path in the message box, ready for the question. */
    private fun askAi(guest: String) {
        val cb = onAskAi ?: return toast(t("Open the chat first", "আগে চ্যাট খুলুন"))
        cb(t("In the sandbox, look at `$guest`: ", "স্যান্ডবক্সে `$guest` দেখো: "))
        finish()
    }

    private fun previewFile(guest: String) {
        selectTab(2)
        openPreview(guest)
    }

    private fun exportFile(guest: String) {
        Thread {
            val msg = try {
                t("Saved to Downloads: ", "ডাউনলোডসে সেভ হয়েছে: ") + sandbox.exportToDownloads(guest)
            } catch (e: Exception) {
                t("Could not save: ", "সেভ করা যায়নি: ") + (e.message ?: "")
            }
            main.post { toast(msg) }
        }.start()
    }

    private fun shareFile(guest: String) {
        val src = sandbox.hostFile(guest)?.takeIf { it.isFile } ?: return toast(t("Can't share this file", "এই ফাইল শেয়ার করা যাচ্ছে না"))
        Thread {
            try {
                // Share from a cache copy: FileProvider does not expose no-backup storage.
                val dir = File(cacheDir, "studio-share").apply { deleteTreeNoFollow(this); mkdirs() }
                val copy = File(dir, src.name)
                src.copyTo(copy, overwrite = true)
                val uri = androidx.core.content.FileProvider.getUriForFile(this, "$packageName.fileprovider", copy)
                val mime = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(copy.extension.lowercase()) ?: "application/octet-stream"
                main.post {
                    runCatching {
                        startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                            type = mime
                            putExtra(Intent.EXTRA_STREAM, uri)
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        }, src.name))
                    }.onFailure { toast(it.message ?: "Share failed") }
                }
            } catch (e: Exception) {
                main.post { toast(t("Could not share: ", "শেয়ার করা যায়নি: ") + (e.message ?: "")) }
            }
        }.start()
    }

    private fun importFiles(uris: List<Uri>) {
        val dir = sandbox.hostFile(cwd)?.takeIf { it.isDirectory } ?: return toast(t("Open a folder first", "আগে একটি ফোল্ডার খুলুন"))
        Thread {
            var ok = 0
            for (uri in uris) {
                runCatching {
                    val name = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                        if (c.moveToFirst()) c.getString(0) else null
                    }?.replace('/', '_')?.takeIf { it.isNotBlank() && it != "." && it != ".." } ?: "file-${System.currentTimeMillis()}"
                    // Never over an existing file ("name_1.ext"), never through a (dangling) symlink.
                    val out = uniqueFileIn(dir, name)
                    if (runCatching { java.nio.file.Files.isSymbolicLink(out.toPath()) }.getOrDefault(false)) out.delete()
                    contentResolver.openInputStream(uri)?.use { input -> out.outputStream().use { o: OutputStream -> input.copyTo(o, 64 * 1024) } }
                    ok++
                }
            }
            main.post {
                toast(t("Imported $ok file(s) into $cwd", "$cwd-এ ${ok}টি ফাইল আনা হয়েছে"))
                loadDir(cwd)
            }
        }.start()
    }

    // ── Preview ──────────────────────────────────────────────────────────────

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildPreview(): View {
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = rounded(cSurface, 22f)
            setPadding(dp(2), 0, dp(2), 0)
            minimumHeight = dp(48)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                setMargins(dp(12), 0, dp(12), dp(8))
            }
        }
        row.addView(iconButton(R.drawable.ic_studio_home, t("Start page: servers and pages", "শুরুর পাতা: সার্ভার ও পেজ")) { showPreviewHome(null) })
        previewUrl = EditText(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setTextColor(cText)
            setHintTextColor(cMuted)
            hint = t("port, URL or file path", "পোর্ট, URL বা ফাইলের পাথ")
            background = null
            isSingleLine = true
            imeOptions = EditorInfo.IME_ACTION_GO or EditorInfo.IME_FLAG_NO_EXTRACT_UI
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
            typeface = mono
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            setOnEditorActionListener { _, _, _ -> openPreview(text.toString()); true }
        }
        row.addView(previewUrl)
        row.addView(iconButton(R.drawable.ic_studio_refresh, t("Reload", "রিলোড")) {
            if (previewOpened) previewWeb.reload() else showPreviewHome(null)
        })
        previewExternal = iconButton(R.drawable.ic_studio_open, t("Open in browser", "ব্রাউজারে খুলুন")) {
            val url = previewWeb.url ?: return@iconButton
            if (!StudioPreview.isPreviewUrl(url)) runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
        }.apply { visibility = View.GONE }
        row.addView(previewExternal)
        box.addView(row)
        previewWeb = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.loadWithOverviewMode = true
            settings.useWideViewPort = true
            settings.builtInZoomControls = true
            settings.displayZoomControls = false
            settings.mediaPlaybackRequiresUserGesture = true
            setBackgroundColor(cBg)
            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val host = request.url.host ?: return false
                    if (host == "127.0.0.1" || host == "localhost" || host == "0.0.0.0" || host == StudioPreview.HOST) return false
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                    return true
                }

                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                        if (request.url.host == StudioPreview.HOST) serveWorkspace(request) else null

                override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                    previewFailed = false
                    previewExternal.visibility = if (url == "about:blank" || StudioPreview.isPreviewUrl(url)) View.GONE else View.VISIBLE
                }

                override fun onPageFinished(view: WebView, url: String) {
                    // Leaving a page (Back to the start page): it must not come back with Back.
                    if (url == "about:blank") { view.clearHistory(); return }
                    if (!previewUrl.hasFocus()) previewUrl.setText(StudioPreview.displayOf(url))
                    if (previewFailed) showPreviewHome(url) else previewHome.visibility = View.GONE
                }

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
                    if (request.isForMainFrame) previewFailed = true
                }
            }
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }
        previewHomeList = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(4), dp(12), dp(24))
        }
        previewHome = ScrollView(this).apply {
            setBackgroundColor(cBg)
            isFillViewport = true
            addView(previewHomeList)
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }
        val stage = FrameLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
            addView(previewWeb)
            addView(previewHome)
        }
        box.addView(stage)
        return box
    }

    // Workspace files for the preview (a background thread of the WebView).

    private val noStore = mapOf("Cache-Control" to "no-store", "Access-Control-Allow-Origin" to "*")

    private fun htmlResponse(html: String, status: Int = 200, reason: String = "OK"): WebResourceResponse =
            WebResourceResponse("text/html", "utf-8", status, reason, noStore, html.toByteArray(Charsets.UTF_8).inputStream())

    private fun fileResponse(f: File): WebResourceResponse {
        val mime = StudioPreview.mimeOf(f.name)
        return WebResourceResponse(mime, if (StudioPreview.isText(mime)) "utf-8" else null, 200, "OK",
                noStore + ("Content-Length" to f.length().toString()), java.io.FileInputStream(f))
    }

    private fun notFound(guest: String): WebResourceResponse = htmlResponse(
            StudioPreview.listingPage(guest, emptyList(), dark, t("Not found in the sandbox.", "স্যান্ডবক্সে পাওয়া যায়নি।")),
            404, "Not Found")

    private fun serveWorkspace(request: WebResourceRequest): WebResourceResponse = try {
        val uri = request.url
        val guest = StudioPreview.guestPathOf(uri.encodedPath)
        val f = guest?.let { sandbox.hostFile(it) }
        when {
            request.method != "GET" && request.method != "HEAD" -> htmlResponse("", 405, "Method Not Allowed")
            guest == null -> htmlResponse("", 400, "Bad Request")
            f == null || !f.exists() -> notFound(guest)
            f.isDirectory -> {
                val index = listOf("index.html", "index.htm").firstNotNullOfOrNull { n ->
                    sandbox.hostFile("$guest/$n")?.takeIf { it.isFile }
                }
                when {
                    // Relative links need the folder's trailing slash.
                    !(uri.encodedPath ?: "/").endsWith("/") -> htmlResponse(StudioPreview.redirectPage(StudioPreview.urlFor(guest, isDir = true)))
                    index != null -> fileResponse(index)
                    else -> htmlResponse(StudioPreview.listingPage(guest,
                            (f.listFiles()?.toList() ?: emptyList()).map { it.name to it.isDirectory }, dark))
                }
            }
            !f.isFile -> notFound(guest)
            request.isForMainFrame && uri.getQueryParameter(StudioPreview.RAW) == null -> when (val kind = StudioPreview.kind(f.name)) {
                StudioPreview.Kind.MARKDOWN -> htmlResponse(StudioPreview.markdownPage(f.name,
                        String(readHead(f, 2 * 1024 * 1024) ?: ByteArray(0), Charsets.UTF_8), dark))
                StudioPreview.Kind.IMAGE, StudioPreview.Kind.VIDEO, StudioPreview.Kind.AUDIO ->
                    htmlResponse(StudioPreview.mediaPage(f.name, kind, dark))
                else -> fileResponse(f)
            }
            else -> fileResponse(f)
        }
    } catch (e: Exception) {
        htmlResponse(StudioPreview.escapeHtml(e.message ?: "error"), 500, "Error")
    }

    // The start page: running servers and pages in the workspace, one tap away.

    /** Shows the start page; [failedUrl] is a page that did not answer. */
    private fun showPreviewHome(failedUrl: String?) {
        if (!::previewHome.isInitialized) return
        val gen = ++homeGeneration
        previewHome.visibility = View.VISIBLE
        previewHome.scrollTo(0, 0)
        val list = previewHomeList
        list.removeAllViews()
        if (failedUrl != null) {
            list.addView(label(t("Nothing is answering at ", "এখানে কিছু চলছে না: ") + StudioPreview.displayOf(failedUrl), 14f, cError).apply {
                setPadding(dp(8), dp(12), dp(8), dp(4))
            })
        }
        list.addView(homeSection(t("Running servers", "চলমান সার্ভার")))
        val servers = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; background = rounded(cSurface, 16f) }
        servers.addView(homeNote(t("Looking for servers…", "সার্ভার খোঁজা হচ্ছে…")))
        list.addView(servers)
        list.addView(homeSection(t("Pages in the workspace", "ওয়ার্কস্পেসের পেজ")))
        val pages = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; background = rounded(cSurface, 16f) }
        pages.addView(homeNote(t("Looking for pages…", "পেজ খোঁজা হচ্ছে…")))
        list.addView(pages)
        list.addView(label(t("Tip: web servers must listen on 0.0.0.0 or 127.0.0.1. Any HTML, Markdown or image file can be opened from Files → Preview, or by typing its path above.",
                "টিপ: ওয়েব সার্ভারকে 0.0.0.0 বা 127.0.0.1-এ চালু করতে হবে। যেকোনো HTML, Markdown বা ছবি ফাইল Files → প্রিভিউ থেকে, বা ওপরে তার পাথ লিখে খোলা যায়।"),
                12.5f, cMuted).apply {
            setLineSpacing(0f, 1.2f)
            setPadding(dp(8), dp(16), dp(8), dp(8))
        })
        Thread {
            val ports = COMMON_PORTS.filter { port ->
                runCatching { java.net.Socket().use { s -> s.connect(java.net.InetSocketAddress("127.0.0.1", port), 200) }; true }.getOrDefault(false)
            }
            val found = findPages()
            main.post {
                if (isDestroyed || gen != homeGeneration) return@post
                servers.removeAllViews()
                if (ports.isEmpty()) {
                    servers.addView(homeNote(t("No web server is running. Ask the AI to start one, or run e.g.\npython3 -m http.server 8000",
                            "কোনো ওয়েব সার্ভার চলছে না। AI-কে একটি চালু করতে বলুন, অথবা চালান যেমন\npython3 -m http.server 8000")))
                } else ports.forEach { port ->
                    servers.addView(homeRow(R.drawable.ic_studio_globe, "127.0.0.1:$port", "http://127.0.0.1:$port/") { openPreview("$port") })
                }
                pages.removeAllViews()
                if (found.isEmpty()) {
                    pages.addView(homeNote(if (sandbox.isInstalled()) t("No HTML or Markdown files in ${Sandbox.WORKSPACE} yet.", "${Sandbox.WORKSPACE}-এ এখনও কোনো HTML বা Markdown ফাইল নেই।")
                    else t("Linux is not set up yet.", "লিনাক্স এখনও প্রস্তুত নয়।")))
                } else found.forEach { guest ->
                    val rel = guest.removePrefix(Sandbox.WORKSPACE + "/")
                    pages.addView(homeRow(R.drawable.ic_studio_file, rel.substringAfterLast('/'), rel.substringBeforeLast('/', "").ifEmpty { "~/workspace" }) { openPreview(guest) })
                }
            }
        }.start()
    }

    /** HTML and Markdown files in the workspace: index pages first, then the newest. */
    private fun findPages(): List<String> {
        val root = sandbox.hostFile(Sandbox.WORKSPACE)?.takeIf { it.isDirectory } ?: return emptyList()
        val skip = setOf("node_modules", "__pycache__", "venv", "dist-packages", "site-packages")
        val out = ArrayList<Pair<String, File>>()
        fun walk(dir: File, guest: String, depth: Int) {
            if (out.size >= 200) return
            val kids = dir.listFiles() ?: return
            for (k in kids) {
                if (k.name.startsWith(".")) continue
                val link = runCatching { java.nio.file.Files.isSymbolicLink(k.toPath()) }.getOrDefault(true)
                if (link) continue
                val g = "$guest/${k.name}"
                if (k.isDirectory) { if (depth < 4 && k.name !in skip) walk(k, g, depth + 1) }
                else if (StudioPreview.kind(k.name).let { it == StudioPreview.Kind.PAGE || it == StudioPreview.Kind.MARKDOWN }) out.add(g to k)
            }
        }
        runCatching { walk(root, Sandbox.WORKSPACE, 0) }
        return out.sortedWith(compareBy<Pair<String, File>>(
                { if (it.second.name.startsWith("index.", ignoreCase = true)) 0 else 1 },
                { -it.second.lastModified() })).take(12).map { it.first }
    }

    private fun homeSection(text: String): TextView = label(text.uppercase(java.util.Locale.getDefault()), 11.5f, cMuted, bold = true).apply {
        letterSpacing = 0.06f
        setPadding(dp(8), dp(18), dp(8), dp(8))
    }

    private fun homeNote(text: String): TextView = label(text, 13.5f, cMuted).apply {
        setLineSpacing(0f, 1.2f)
        setPadding(dp(16), dp(14), dp(16), dp(14))
    }

    private fun homeRow(icon: Int, title: String, sub: String, onClick: () -> Unit): View = newFileRow().apply {
        (getChildAt(0) as android.widget.ImageView).apply {
            setImageResource(icon)
            imageTintList = ColorStateList.valueOf(cAccent)
            background = rounded(cBg, 10f)
        }
        val texts = getChildAt(1) as LinearLayout
        (texts.getChildAt(0) as TextView).text = title
        (texts.getChildAt(1) as TextView).text = sub
        setOnClickListener { onClick() }
    }

    private fun openPreview(raw: String) {
        var url = raw.trim()
        if (url.isEmpty()) return
        // "site/index.html": a workspace path when such a file exists, else a host name.
        val relativeFile = !url.contains("://") && !url.matches(Regex("^\\d{2,5}(/.*)?$")) &&
                sandbox.hostFile(Sandbox.guestPath(url))?.exists() == true
        if (url.startsWith("/") || url.startsWith("~") || relativeFile) {
            // A file or folder in the sandbox.
            val guest = Sandbox.guestPath(url)
            val f = sandbox.hostFile(guest)
            url = StudioPreview.urlFor(guest, isDir = f?.isDirectory == true)
        } else {
            if (url.matches(Regex("^\\d{2,5}(/.*)?$"))) url = "http://127.0.0.1:$url"
            if (!url.contains("://")) url = "http://$url"
            url = url.replace("://0.0.0.0", "://127.0.0.1").replace("://localhost", "://127.0.0.1")
        }
        previewUrl.setText(StudioPreview.displayOf(url))
        previewUrl.clearFocus()
        hideKeyboard(previewUrl)
        previewOpened = true
        previewHome.visibility = View.GONE
        previewWeb.loadUrl(url)
    }

    private fun hideKeyboard(v: View) {
        runCatching {
            (getSystemService(Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager).hideSoftInputFromWindow(v.windowToken, 0)
        }
    }

    /** The AI changed a file: refresh what shows it. */
    private fun onFileChanged(guest: String) {
        if (currentTab == 1) loadDir(cwd)
        val shown = previewWeb.url ?: return
        if (currentTab == 2 && previewOpened && StudioPreview.isPreviewUrl(shown)) {
            val showing = StudioPreview.displayOf(shown)
            val dir = if (shown.substringBefore('?').endsWith("/")) showing else showing.substringBeforeLast('/')
            // The page itself, or anything in its folder (its CSS, JS, images).
            if (guest == showing || guest.startsWith("$dir/")) previewWeb.reload()
        }
    }
}
