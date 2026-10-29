package com.superdeepseek.app

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.MotionEvent
import android.view.PixelCopy
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import android.widget.FrameLayout
import android.provider.MediaStore
import androidx.core.content.FileProvider
import java.io.File
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.UserAgentMetadata
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewFeature

// Helper functions for unit tests
internal fun applyRootWindowInsets(view: View, windowInsets: WindowInsetsCompat): WindowInsetsCompat {
    val systemBars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars())
    val imeInsets = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
    val bottomInset = maxOf(systemBars.bottom, imeInsets.bottom)
    view.setPadding(systemBars.left, systemBars.top, systemBars.right, bottomInset)
    view.translationY = 0f
    return WindowInsetsCompat.CONSUMED
}

/**
 * Parses the page-colour probe result: the raw evaluateJavascript value of an
 * "r,g,b" string (JSON-quoted, e.g. "\"255,255,255\""). Null when unusable.
 */
internal fun parseRgb(raw: String?): Int? {
    val parts = raw?.trim()?.trim('"')?.split(',') ?: return null
    if (parts.size != 3) return null
    val rgb = parts.map { it.trim().toIntOrNull() ?: return null }
    if (rgb.any { it !in 0..255 }) return null
    return (0xFF shl 24) or (rgb[0] shl 16) or (rgb[1] shl 8) or rgb[2]
}

/**
 * The colour covering the largest share of [pixels] (ARGB), or null when no
 * single colour reaches [minShare]. Used on a thin strip of the rendered page:
 * the page background wins even when a few icon or text pixels cross it.
 */
internal fun dominantColor(pixels: IntArray, minShare: Float = 0.4f): Int? {
    if (pixels.isEmpty()) return null
    val counts = HashMap<Int, Int>()
    var best = 0
    var bestCount = 0
    for (px in pixels) {
        val c = px or (0xFF shl 24)
        val n = (counts[c] ?: 0) + 1
        counts[c] = n
        if (n > bestCount) { best = c; bestCount = n }
    }
    return if (bestCount >= pixels.size * minShare) best else null
}

/** Perceived brightness of [color], 0 (black) to 255 (white). */
internal fun perceivedLuminance(color: Int): Double {
    val r = (color shr 16) and 0xFF
    val g = (color shr 8) and 0xFF
    val b = color and 0xFF
    return 0.299 * r + 0.587 * g + 0.114 * b
}

/** True when dark system-bar icons are the readable choice on [color]. */
internal fun isLightColor(color: Int): Boolean = perceivedLuminance(color) > 150.0

internal fun shouldOpenExternally(url: Uri, assetHost: String = "bds-asset.local"): Boolean {
    val scheme = url.scheme?.lowercase() ?: return false
    if (scheme != "http" && scheme != "https") return false
    val host = url.host?.lowercase() ?: return false
    if (host == assetHost.lowercase()) return false
    if (host == "appassets.androidplatform.net") return false
    if (host == "deepseek.com" || host.endsWith(".deepseek.com")) return false
    if (host == "hcaptcha.com" || host.endsWith(".hcaptcha.com")) return false
    if (isGoogleAuthHost(host)) return false
    return true
}

internal fun isGoogleAuthHost(host: String): Boolean {
    val h = host.lowercase()
    return h == "google.com" || h.endsWith(".google.com") || h == "accounts.youtube.com" || h == "googleusercontent.com" || h.endsWith(".googleusercontent.com")
}

internal fun shouldCapturePopupInApp(url: Uri, assetHost: String = "bds-asset.local"): Boolean {
    return !shouldOpenExternally(url, assetHost)
}

internal fun shouldOpenRequestExternally(request: WebResourceRequest, assetHost: String = "bds-asset.local"): Boolean {
    if (!request.isForMainFrame) return false
    val url = request.url ?: return false
    if (!shouldOpenExternally(url, assetHost)) return false
    return request.hasGesture()
}

internal fun deriveWebViewUserAgent(defaultUserAgent: String): String {
    return defaultUserAgent.replace(Regex(""";\s*wv(?=\))"""), "").replace(Regex("""\bVersion/\d+(?:\.\d+)*\s*"""), "").replace(Regex("""\s+"""), " ").trim()
}

internal fun parseChromeMajorVersion(ua: String): String? {
    return CHROME_VERSION_REGEX.find(ua)?.groupValues?.get(1)?.substringBefore('.')
}

internal fun parseAndroidPlatformVersion(ua: String): String? {
    return Regex("""Android\s+(\d+(?:\.\d+)*)""").find(ua)?.groupValues?.get(1)
}

internal fun parseDeviceModel(ua: String): String? {
    val inner = Regex("""Android\s+[\d.]+;\s*([^;)]+)""").find(ua)?.groupValues?.get(1)?.trim() ?: return null
    return inner.substringBefore(" Build/").trim().ifBlank { null }
}

internal fun buildUserAgentMetadata(derivedUa: String): UserAgentMetadata {
    val builder = UserAgentMetadata.Builder().setPlatform("Android").setMobile(true)
    val chromeVersion = CHROME_VERSION_REGEX.find(derivedUa)?.groupValues?.get(1)
    if (chromeVersion != null) {
        val majorVersion = chromeVersion.substringBefore('.')
        val brandVersions = listOf(
            UserAgentMetadata.BrandVersion.Builder().setBrand("Not/A)Brand").setMajorVersion("8").setFullVersion("8.0.0.0").build(),
            UserAgentMetadata.BrandVersion.Builder().setBrand("Chromium").setMajorVersion(majorVersion).setFullVersion(chromeVersion).build(),
            UserAgentMetadata.BrandVersion.Builder().setBrand("Google Chrome").setMajorVersion(majorVersion).setFullVersion(chromeVersion).build(),
        )
        builder.setFullVersion(chromeVersion).setBrandVersionList(brandVersions)
    }
    builder.setArchitecture("").setBitness(UserAgentMetadata.BITNESS_DEFAULT)
    parseAndroidPlatformVersion(derivedUa)?.let { builder.setPlatformVersion(it) }
    parseDeviceModel(derivedUa)?.let { builder.setModel(it) }
    return builder.build()
}

internal fun buildFileChooserIntent(acceptTypes: Array<String>?, allowMultiple: Boolean): Intent {
    return Intent(Intent.ACTION_GET_CONTENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = "*/*"
        if (allowMultiple) putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        val mimeTypes = mapAcceptTypes(acceptTypes)
        if (mimeTypes.isNotEmpty()) putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toTypedArray())
    }
}

/** Which Android picker serves an engine `AndroidBridge.pickFiles(mode)` request. */
internal enum class NativePickKind { CAMERA, PHOTOS, FOLDER, FILES }

/** Most photos the gallery picker hands back in one go. */
internal const val MAX_GALLERY_PICK = 10

/**
 * Maps the engine's pick modes onto pickers. "files+images" is still the
 * generic file picker — the suffix only means picked images are accepted.
 * Unknown modes fall back to the generic file picker.
 */
internal fun nativePickKind(mode: String): NativePickKind = when {
    mode == "camera" -> NativePickKind.CAMERA
    mode == "images" -> NativePickKind.PHOTOS
    mode.startsWith("folder") -> NativePickKind.FOLDER
    else -> NativePickKind.FILES
}

/** Whether picked images should be delivered (as images) for this mode. */
internal fun nativePickAcceptsImages(mode: String): Boolean =
    mode == "camera" || mode.contains("images")

/** ACTION_IMAGE_CAPTURE writing the full-size photo to [output] (a FileProvider URI). */
internal fun buildCameraIntent(output: Uri): Intent =
    Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
        putExtra(MediaStore.EXTRA_OUTPUT, output)
        addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

/**
 * Gallery picker for devices without the system Photo Picker: ACTION_PICK on
 * MediaStore images opens a gallery app, not the Files/Documents browser.
 */
internal fun buildGalleryFallbackIntent(): Intent =
    Intent(Intent.ACTION_PICK).apply {
        setDataAndType(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, "image/*")
        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
    }

/** Every URI a picker returned (multi-select clipData and/or single data), de-duplicated. */
internal fun parsePickedUris(data: Intent?): List<Uri> {
    val uris = linkedSetOf<Uri>()
    data?.clipData?.let { clip ->
        for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { uris.add(it) }
    }
    data?.data?.let { uris.add(it) }
    return uris.toList()
}

internal fun parseFileChooserResult(resultCode: Int, data: Intent?): Array<Uri>? {
    if (resultCode != Activity.RESULT_OK) return null
    val uris = linkedSetOf<Uri>()
    val clipData = data?.clipData
    if (clipData != null) {
        for (i in 0 until clipData.itemCount) clipData.getItemAt(i).uri?.let { uris.add(it) }
    } else {
        data?.data?.let { uris.add(it) }
    }
    if (uris.isNotEmpty()) return uris.toTypedArray()
    return runCatching { WebChromeClient.FileChooserParams.parseResult(resultCode, data) }.getOrNull()?.takeIf { it.isNotEmpty() }
}

/**
 * The picker is only filtered when the page asks for MIME types (e.g. images
 * only). File-extension lists (DeepSeek's upload button lists dozens of
 * code/document extensions) are NOT turned into a filter: document providers
 * label most code and text files `application/octet-stream`, so a MIME filter
 * greyed them out and those files could not be picked at all. The page still
 * checks what it accepts after the pick.
 */
private fun mapAcceptTypes(acceptTypes: Array<String>?): List<String> {
    val tokens = acceptTypes?.flatMap { it.split(',') }?.map { it.trim() }?.filter { it.isNotEmpty() }.orEmpty()
    if (tokens.isEmpty()) return emptyList()
    val mapped = linkedSetOf<String>()
    for (token in tokens) {
        if (!Regex("^[A-Za-z0-9.+-]+/[A-Za-z0-9.+*-]+$").matches(token) || token == "*/*") return emptyList()
        mapped.add(token.lowercase())
    }
    return mapped.toList()
}

private val CHROME_VERSION_REGEX = Regex("""\bChrome/(\d+(?:\.\d+)*)""")

/**
 * Super DeepSeek's single activity.
 *
 * The official chat (https://chat.deepseek.com) runs in [officialWebView]: the
 * user signs in there exactly as on the web, with the site's own cookies and
 * WAF session. On every page load the Super DeepSeek engine (assets/bds) is
 * injected into that page, and [WebViewBridge] (`window.AndroidBridge`) gives
 * it native storage, file picking, downloads, fetch, MCP and the Linux
 * sandbox — only while the page is https://chat.deepseek.com.
 *
 * A native launch screen ([BootScreenView]) covers the page until the
 * enhanced chat is really on screen, so the plain official UI never flashes.
 */
class MainActivity : ComponentActivity() {

    /** The chat's host: blob paths are only served on it (and the engine asset host). */
    private val DS_HOST = "chat.deepseek.com"

    private lateinit var officialWebView: WebView
    private lateinit var rootLayout: FrameLayout

    private val bdsAssetHost by lazy { getString(R.string.bds_asset_authority) }

    /** Serves the engine bundle (assets/bds) at the bds-asset.local authority. */
    private lateinit var bdsAssetLoader: WebViewAssetLoader
    private lateinit var bridge: WebViewBridge
    /** Token-gated front of [bridge]; the only object injected into the WebView (see BridgeGate). */
    private lateinit var bridgeGate: BridgeGate
    private lateinit var cookieManager: CookieManager
    private var pendingFileChooser: ValueCallback<Array<Uri>>? = null
    private var cameraPhotoUri: Uri? = null

    /**
     * `<input capture>` must launch a real camera intent; the document picker
     * that FileChooserParams.createIntent() builds rarely offers one, which is
     * why "Camera" appeared dead. The photo lands in our cache via FileProvider
     * and is handed back through [fileChooserLauncher].
     */
    private fun buildCameraCaptureIntent(): Intent? {
        return try {
            val file = File(cacheDir, "capture-${System.currentTimeMillis()}.jpg")
            val uri = FileProvider.getUriForFile(this, "${packageName}.fileprovider", file)
            cameraPhotoUri = uri
            buildCameraIntent(uri)
        } catch (t: Throwable) {
            Log.e("SuperDeepSeek", "Camera intent failed", t)
            cameraPhotoUri = null
            null
        }
    }
    private val handler = Handler(Looper.getMainLooper())

    /** Engine native-pick request waiting for [nativePickLauncher]: id to mode. */
    private var nativePickRequest: Pair<String, String>? = null

    /** Where the camera writes the photo for a native "camera" pick (FileProvider URI). */
    private var nativeCameraUri: Uri? = null

    /**
     * The engine (injected into the official DeepSeek page) asks the native
     * side to pick files (`AndroidBridge.pickFiles(mode, requestId)`) and waits
     * for CustomEvents delivered back INTO THE SAME WebView: status "opened"
     * once the picker is up, status "reading" while files are read, then the
     * chunked result. The engine rejects any other status phase as a malformed
     * payload, so these exact phases matter.
     *
     * Files are read off the main thread — a large pick must not freeze the UI.
     */
    private val nativePickLauncher: ActivityResultLauncher<Intent> =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val request = nativePickRequest
            nativePickRequest = null
            val cameraUri = nativeCameraUri
            nativeCameraUri = null
            if (request == null) return@registerForActivityResult
            val (requestId, mode) = request
            if (result.resultCode != Activity.RESULT_OK) {
                bridge.deliverPickError(requestId, "cancelled")
                return@registerForActivityResult
            }
            val kind = nativePickKind(mode)
            val data = result.data
            val folder = if (kind == NativePickKind.FOLDER) data?.data else null
            // ACTION_IMAGE_CAPTURE returns no data intent: the photo is at EXTRA_OUTPUT.
            val uris = if (kind == NativePickKind.CAMERA) listOfNotNull(cameraUri) else parsePickedUris(data)
            if (folder == null && uris.isEmpty()) {
                bridge.deliverPickError(requestId, "cancelled")
                return@registerForActivityResult
            }
            if (folder != null) {
                runCatching {
                    contentResolver.takePersistableUriPermission(folder, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
            }
            bridge.deliverPickStatus(requestId, "reading")
            val acceptImages = nativePickAcceptsImages(mode)
            Thread {
                try {
                    if (folder != null) {
                        val read = bridge.readPickedFolderTree(folder, acceptImages)
                        bridge.deliverPickedFiles(requestId, read.files, read.skipped, read.folderName)
                        return@Thread
                    }
                    val (files, skipped) = bridge.readPickedContentUris(uris, acceptImages)
                    // All skipped: still a result, so the page can say why (too large…).
                    if (files.isEmpty() && skipped.isEmpty()) bridge.deliverPickError(requestId, "no-readable-files")
                    else bridge.deliverPickedFiles(requestId, files, skipped, null)
                } catch (t: Throwable) {
                    Log.e("SuperDeepSeek", "Native pick handling failed", t)
                    bridge.deliverPickError(requestId, "read-failed")
                }
            }.start()
        }

    /**
     * Builds the picker for one engine pick mode (see [nativePickKind]):
     *  - camera → the camera app directly (photo lands in our cache via FileProvider);
     *  - images → the gallery: the system Photo Picker where available, otherwise
     *    ACTION_PICK on MediaStore images (a gallery app, never the Files browser);
     *  - folder → the document-tree picker;
     *  - files  → the generic "any file" document picker.
     */
    private fun buildNativePickIntent(mode: String): Intent = when (nativePickKind(mode)) {
        NativePickKind.CAMERA -> {
            val file = File(cacheDir, "capture-${System.currentTimeMillis()}.jpg")
            val uri = FileProvider.getUriForFile(this, "${packageName}.fileprovider", file)
            nativeCameraUri = uri
            buildCameraIntent(uri)
        }
        NativePickKind.PHOTOS -> {
            if (ActivityResultContracts.PickVisualMedia.isPhotoPickerAvailable(this)) {
                ActivityResultContracts.PickMultipleVisualMedia(MAX_GALLERY_PICK).createIntent(
                    this,
                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                )
            } else {
                buildGalleryFallbackIntent()
            }
        }
        NativePickKind.FOLDER -> Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        NativePickKind.FILES -> buildFileChooserIntent(null, true)
    }

    private var pendingWebPermission: android.webkit.PermissionRequest? = null

    private val micPermissionLauncher: ActivityResultLauncher<String> =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            val request = pendingWebPermission ?: return@registerForActivityResult
            pendingWebPermission = null
            runCatching {
                if (granted) request.grant(arrayOf(android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else request.deny()
            }
        }

    /** Grants the microphone to the chat page (asking the user first); denies everything else. */
    private fun handleWebPermission(request: android.webkit.PermissionRequest) {
        val host = request.origin?.host
        val wantsMic = android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE in request.resources
        if (!wantsMic || (host != DS_HOST && host != bdsAssetHost)) {
            runCatching { request.deny() }
            return
        }
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            runCatching { request.grant(arrayOf(android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE)) }
            return
        }
        pendingWebPermission?.let { runCatching { it.deny() } }
        pendingWebPermission = request
        runCatching { micPermissionLauncher.launch(android.Manifest.permission.RECORD_AUDIO) }
            .onFailure { pendingWebPermission = null; runCatching { request.deny() } }
    }

    private val notificationPermissionLauncher: ActivityResultLauncher<String> =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    /**
     * Android 13+: the sandbox's "running · Stop" notification needs this
     * permission. Asked once, the first time the AI starts a sandbox command.
     */
    private fun maybeAskNotificationPermission() {
        if (android.os.Build.VERSION.SDK_INT < 33) return
        if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED) return
        val prefs = getSharedPreferences(WebViewBridge.PREFS_NAME, MODE_PRIVATE)
        if (prefs.getBoolean(KEY_ASKED_NOTIFICATIONS, false)) return
        prefs.edit().putBoolean(KEY_ASKED_NOTIFICATIONS, true).apply()
        runCatching { notificationPermissionLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS) }
    }

    private val storagePermissionLauncher: ActivityResultLauncher<String> =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }
    private var askedStoragePermission = false

    /**
     * Android 8–9 only: shared Downloads needs a runtime permission. Asked once
     * per launch when the user downloads something; until it is granted,
     * downloads go to the app's own Downloads folder ([LegacyDownloads]).
     */
    private fun maybeAskStoragePermission() {
        if (LegacyDownloads.canWriteSharedFolder(this) || askedStoragePermission) return
        askedStoragePermission = true
        runCatching { storagePermissionLauncher.launch(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) }
    }

    private val fileChooserLauncher: ActivityResultLauncher<Intent> =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val callback = pendingFileChooser
            pendingFileChooser = null
            val captureUri = cameraPhotoUri
            cameraPhotoUri = null
            callback?.onReceiveValue(
                if (result.resultCode == Activity.RESULT_OK) {
                    result.data?.let { intent ->
                        val clip = intent.clipData
                        if (clip != null) Array(clip.itemCount) { i -> clip.getItemAt(i).uri }
                        else intent.data?.let { arrayOf(it) }
                    }
                        // Camera capture returns no data intent; the photo is at EXTRA_OUTPUT.
                        ?: captureUri?.let { arrayOf(it) }
                } else null
            )
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        val splashScreen = installSplashScreen()
        super.onCreate(savedInstanceState)

        // The system splash hands over on our first frame: that frame is already
        // the native launch screen (same background colour, icon at the same
        // centre), which then covers the page until it is really ready. Holding
        // the splash longer would only hide the launch animation's intro.
        splashScreen.setKeepOnScreenCondition { false }

        WindowCompat.setDecorFitsSystemWindows(window, false)
        pageBarColor = storedDarkPageColor()
        pageNavBarColor = pageBarColor
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        // No system scrim over the bars: their colour is exactly the page's.
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            window.isStatusBarContrastEnforced = false
            window.isNavigationBarContrastEnforced = false
        }

        cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)

        bridge = WebViewBridge(applicationContext)
        bridgeGate = BridgeGate(bridge)
        // Service-worker fetches bypass WebViewClient.shouldInterceptRequest; a
        // page worker must not turn the blob paths into network 404s.
        try {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE) &&
                WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_SHOULD_INTERCEPT_REQUEST)) {
                val blobs = bridge.blobs
                androidx.webkit.ServiceWorkerControllerCompat.getInstance().setServiceWorkerClient(
                    object : androidx.webkit.ServiceWorkerClientCompat() {
                        override fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse? {
                            val path = request.url?.path ?: return null
                            return if (path.startsWith(NativeBlobStore.PATH_PREFIX)) blobs.serve(path) else null
                        }
                    })
            }
        } catch (t: Throwable) {
            // Optional: without it only worker-originated blob fetches miss.
            Log.w("SuperDeepSeek", "Service-worker client unavailable", t)
        }
        // Engine bundle lives at assets/bds and is requested as
        // https://bds-asset.local/bds/... by WebViewBridge.getAssetUrl().
        bdsAssetLoader = WebViewAssetLoader.Builder()
            .setDomain(getString(R.string.bds_asset_authority))
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        // Official DeepSeek WebView - visible for official login
        officialWebView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            // Keep the chat's renderer at foreground priority even when the app
            // is in the background, so a long agent run is not starved or killed.
            runCatching { setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false) }
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                useWideViewPort = true
                loadWithOverviewMode = true
                mediaPlaybackRequiresUserGesture = false
                mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                cacheMode = WebSettings.LOAD_DEFAULT
                userAgentString = deriveWebViewUserAgent(WebSettings.getDefaultUserAgent(this@MainActivity))
                setSupportMultipleWindows(true)
                javaScriptCanOpenWindowsAutomatically = true
            }
            // Never the raw bridge: injected objects reach every (sandboxed) iframe.
            addJavascriptInterface(bridgeGate, BridgeGate.GATE_NAME)
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    // Serve the engine's bundled assets (fish loading SVGs, icons, sandbox)
                    // from assets/bds via the bds-asset.local authority. Real site traffic
                    // (login/WAF) passes through untouched.
                    val url = request.url
                    // Picked/shared files and large bridge replies, streamed (NativeBlobStore).
                    if (url.path?.startsWith(NativeBlobStore.PATH_PREFIX) == true &&
                        (url.host == DS_HOST || url.host == bdsAssetHost)) {
                        return bridge.blobs.serve(url.path)
                    }
                    if (url.host == bdsAssetHost) {
                        return bdsAssetLoader.shouldInterceptRequest(url)
                    }
                    return null
                }
                override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                    // Without this the whole app died with the renderer (often an
                    // out-of-memory kill in the background). Rebuild the Activity with
                    // a fresh WebView instead; the session cookies survive.
                    Log.e("SuperDeepSeek", "Renderer gone (crash=${detail.didCrash()}); recreating")
                    recoverFromRendererLoss(view)
                    return true
                }
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (!shouldOpenRequestExternally(request, bdsAssetHost)) return false
                    // Open external links in browser
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, request.url))
                    } catch (_: Exception) {}
                    return true
                }
                override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                    super.onPageStarted(view, url, favicon)
                    // A navigation invalidates any asynchronous probe or asset-load result
                    // started for the previous document.
                    pageSurfaceWatchGeneration += 1
                    handler.removeCallbacks(pageSurfacePoll)
                    // The bridge (storage, files, MCP keys, the Linux sandbox) only
                    // serves the DeepSeek page — never a foreign page this WebView
                    // may be redirected to.
                    bridge.trustedPage = isTrustedBridgeUrl(url)
                }
                override fun onPageFinished(view: WebView, url: String?) {
                    super.onPageFinished(view, url)
                    Log.d("SuperDeepSeek", "Official WebView loaded: $url")
                    if (isTrustedBridgeUrl(url)) {
                        // Leave DeepSeek's sign-in and CAPTCHA surface untouched. The
                        // engine starts only once the real chat composer is visible.
                        startPageSurfaceWatch(view)
                        syncSystemBarsWithPage()
                        if (bootView == null) scheduleBarRefresh(BAR_REFRESH_THEME_MS)
                    }
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(webView: WebView?, filePathCallback: ValueCallback<Array<Uri>>?, fileChooserParams: FileChooserParams?): Boolean {
                    pendingFileChooser?.onReceiveValue(null)
                    val callback = filePathCallback ?: return true
                    pendingFileChooser = callback
                    return try {
                        val capture = fileChooserParams?.isCaptureEnabled == true
                        val intent = if (capture) {
                            buildCameraCaptureIntent()
                                ?: buildFileChooserIntent(fileChooserParams?.acceptTypes, false)
                        } else {
                            buildFileChooserIntent(
                                fileChooserParams?.acceptTypes,
                                fileChooserParams?.mode == FileChooserParams.MODE_OPEN_MULTIPLE,
                            )
                        }
                        fileChooserLauncher.launch(intent)
                        true
                    } catch (t: Throwable) {
                        Log.e("SuperDeepSeek", "File chooser failed", t)
                        pendingFileChooser = null
                        callback.onReceiveValue(null)
                        true
                    }
                }

                // Voice input (getUserMedia): the page only ever gets the
                // microphone, and only after the user allowed it for the app.
                override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
                    runOnUiThread { handleWebPermission(request) }
                }

                override fun onPermissionRequestCanceled(request: android.webkit.PermissionRequest) {
                    if (pendingWebPermission === request) pendingWebPermission = null
                }

                // setSupportMultipleWindows(true) without this handler silently
                // dropped every window.open / target=_blank: "Sign in with Google"
                // popups and new-tab links did nothing.
                override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message): Boolean =
                    openPopupWindow(resultMsg)
            }
            setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
                handleWebDownload(url, userAgent, contentDisposition, mimeType)
            }
            // Dark background so there is no white flash while the page/engine loads.
            setBackgroundColor(Color.parseColor("#1e1f23")) // engine panel dark — matches the official page
        }

        cookieManager.setAcceptThirdPartyCookies(officialWebView, true)

        // The engine bundle runs INSIDE the official WebView, so every script
        // the bridge posts (native pick results, MCP replies, theme events…)
        // is evaluated there.
        bridge.scriptPoster = { script ->
            officialWebView.post { officialWebView.evaluateJavascript(script, null) }
        }
        bridge.evaluateJs = { script ->
            officialWebView.post { officialWebView.evaluateJavascript(script, null) }
        }
        bridge.onPickFiles = { mode, requestId ->
            handler.post {
                try {
                    nativePickRequest = requestId to mode
                    nativePickLauncher.launch(buildNativePickIntent(mode))
                    // "opened" is the phase the engine expects once a picker is up.
                    bridge.deliverPickStatus(requestId, "opened")
                } catch (t: Throwable) {
                    Log.e("SuperDeepSeek", "Native pick launch failed", t)
                    nativePickRequest = null
                    nativeCameraUri = null
                    bridge.deliverPickError(requestId, "picker-launch-failed")
                }
            }
        }

        rootLayout = FrameLayout(this).apply {
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            setBackgroundColor(pageBarColor) // recoloured to the page's own background
            addView(officialWebView)
        }

        ViewCompat.setOnApplyWindowInsetsListener(rootLayout) { view, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val bottom = maxOf(systemBars.bottom, ime.bottom)
            view.setPadding(systemBars.left, systemBars.top, systemBars.right, bottom)
            WindowInsetsCompat.CONSUMED
        }

        setContentView(rootLayout)

        // Launch screen: takes over from the system splash and stays until the
        // enhanced page is really on screen (polish signal + readiness probe).
        bridge.onUiPolishedCallback = {
            runOnUiThread {
                uiPolished = true
                startReadyPoll()
            }
        }
        // The engine reports every light/dark switch of the page; recolour the
        // bars at once, then sample the exact page colour after the switch paints.
        bridge.onThemeChanged = { isDark ->
            runOnUiThread {
                applyPageBarColor(if (isDark) storedDarkPageColor() else Color.WHITE)
                mayRememberDarkColor = isDark
                scheduleBarRefresh(BAR_REFRESH_THEME_MS)
            }
        }
        // Linux sandbox: the preview tool, the Studio entry points and the
        // notification's Stop action.
        bridge.sandboxPreview = { url ->
            if (isForeground || StudioActivity.visible) {
                runOnUiThread { StudioActivity.start(this, url) }
                true
            } else false
        }
        bridge.onOpenStudio = { runOnUiThread { StudioActivity.start(this) } }
        StudioActivity.onAskAi = askAiInPage
        bridge.onDownloadRequested = { runOnUiThread { maybeAskStoragePermission() } }
        bridge.onSandboxCallStarted = { runOnUiThread { maybeAskNotificationPermission() } }
        SandboxService.onStopRequested = stopAgentInPage
        showNativeBootOverlay()

        // The official DeepSeek site is shown in this WebView. Keep the sign-in
        // and CAPTCHA flow untouched; the engine (assets/bds) starts only after a
        // real chat composer appears. After a renderer crash or process restore,
        // the open conversation is reopened instead of a blank chat.
        val restoreUrl = savedInstanceState?.getString(KEY_CHAT_URL) ?: rendererLostUrl
        rendererLostUrl = null
        officialWebView.loadUrl(ChatUrls.restorable(restoreUrl) ?: "https://chat.deepseek.com/")
        handleIncomingIntent(intent)
        // The session token is not ours to keep (a legacy build stored it in plain prefs).
        Thread {
            runCatching { bridge.removeLegacyToken() }
            cleanupOldCaptures(cacheDir)
        }.start()
        maybeCheckForUpdate()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Back may close a sheet or drawer without any touch: re-measure the bars.
                if (bootView == null) scheduleBarRefresh(BAR_REFRESH_TOUCH_MS)
                popupWebView?.let { popup ->
                    if (popup.canGoBack()) popup.goBack() else closePopupWindow()
                    return
                }
                // Let the engine close its own sheet, dialog or command popup first;
                // only navigate the page when nothing of ours was open.
                officialWebView.evaluateJavascript("(function(){try{return !!(window.__sdHandleBack&&window.__sdHandleBack());}catch(e){return false;}})()") { result ->
                    if (result != "true" && result != "\"true\"") {
                        if (officialWebView.canGoBack()) officialWebView.goBack()
                        else moveTaskToBack(true)
                    }
                }
            }
        })
    }

    private fun readAsset(name: String): String? = try {
        assets.open("bds/$name").bufferedReader().use { it.readText() }
    } catch (e: Exception) { null }

    /** The engine scripts, read once and off the main thread (content.js is ~3 MB). */
    private class EngineAssets(val injected: String?, val cssJs: String?, val content: String?, val native: List<Pair<String, String>>)

    @Volatile private var engineAssets: EngineAssets? = null
    private val engineAssetsLock = Any()

    private fun loadEngineAssets(): EngineAssets {
        engineAssets?.let { return it }
        synchronized(engineAssetsLock) {
            engineAssets?.let { return it }
            val css = buildString {
                readAsset("content.css")?.let { append(it).append("\n") }
                // Our design frame on top of the engine's UI.
                readAsset("our-skin.css")?.let { append(it).append("\n") }
                // Safe, schema-driven assistant UI.
                readAsset("sd-genui.css")?.let { append(it) }
            }
            val cssJs = if (css.isBlank()) null else """
                (function(){
                  var old = document.getElementById('bds-css');
                  if (old) old.remove();
                  var s = document.createElement('style');
                  s.id = 'bds-css';
                  s.textContent = ${org.json.JSONObject.quote(css)};
                  document.head.appendChild(s);
                })();
            """.trimIndent()
            // Native glue → sandbox agent → sheet gestures → safe GenUI.
            // Each module is evaluated as its own script so a top-level failure in
            // one (e.g. a host-page change) cannot stop the others from loading.
            val native = NATIVE_MODULES.mapNotNull { name -> readAsset(name)?.let { name to it } }
            return EngineAssets(readAsset("injected.js"), cssJs, readAsset("content.js"), native)
                .also { engineAssets = it }
        }
    }

    /**
     * Inject the engine into the live official chat page, once per document.
     * onPageFinished can fire more than once for one document (redirects,
     * history hops) and content.js has no load guard of its own: a second run
     * duplicated the engine's UI and listeners. Order matters: injected.js
     * (network hooks) first, then the CSS, content.js, the native glue
     * (sd-native.js), sheet gestures, the GenUI renderer and the polish pass.
     */
    private fun injectBdsScripts(webView: WebView, generation: Int, documentToken: String) {
        Thread {
            val a = loadEngineAssets()
            runOnUiThread {
                if (isFinishing || isDestroyed || webView !== officialWebView ||
                    generation != pageSurfaceWatchGeneration ||
                    !isTrustedBridgeUrl(runCatching { webView.url }.getOrNull())
                ) return@runOnUiThread

                // Asset loading is asynchronous. Claim only if the current document is still
                // the one whose chat surface was detected, and re-probe its live DOM in the
                // same evaluation that sets the per-document marker. Unknown/auth/stale
                // outcomes fail closed and leave the surface watcher running for a later chat.
                webView.evaluateJavascript(buildDeepSeekEngineClaimScript(documentToken)) { r ->
                    if (isFinishing || isDestroyed || webView !== officialWebView ||
                        generation != pageSurfaceWatchGeneration ||
                        !isTrustedBridgeUrl(runCatching { webView.url }.getOrNull())
                    ) return@evaluateJavascript

                    when (parseDeepSeekEngineClaimResult(r)) {
                        DeepSeekEngineClaimResult.ALREADY_PRESENT -> {
                            Log.d("BDS", "engine already present in this chat document")
                            webView.evaluateJavascript(bridgeGate.shimScript(), null)
                            flushPendingPageActions()
                            return@evaluateJavascript
                        }
                        DeepSeekEngineClaimResult.CLAIMED -> {
                            // window.AndroidBridge for the main frame only (token in a closure).
                            webView.evaluateJavascript(bridgeGate.shimScript(), null)
                            a.injected?.let { webView.evaluateJavascript(it) { Log.d("BDS", "injected.js done") } }
                            a.cssJs?.let { webView.evaluateJavascript(it) { Log.d("BDS", "content.css done") } }
                            a.content?.let { webView.evaluateJavascript(it) { Log.d("BDS", "content.js done") } }
                            a.native.forEach { (name, src) -> webView.evaluateJavascript(src) { Log.d("BDS", "$name done") } }
                            // Hides out-of-scope features and polishes; it signals
                            // AndroidBridge.onUiPolished(), which releases the launch screen.
                            injectUiPolish(webView)
                            flushPendingPageActions()
                        }
                        DeepSeekEngineClaimResult.AUTH,
                        DeepSeekEngineClaimResult.LOADING,
                        DeepSeekEngineClaimResult.STALE,
                        DeepSeekEngineClaimResult.UNKNOWN -> {
                            Log.d("BDS", "Engine injection deferred; current page is not the detected chat document")
                            handler.removeCallbacks(pageSurfacePoll)
                            handler.postDelayed(pageSurfacePoll, DEEPSEEK_AUTH_POLL_MS)
                        }
                    }
                }
            }
        }.start()
    }

    /**
     * Poll the live page before injecting anything. The sign-in form and CAPTCHA
     * are part of DeepSeek's own web app; our content/UI hooks are only needed
     * after the chat composer exists. This also covers SPA login flows, where
     * changing from sign-in to chat does not produce another onPageFinished.
     */
    private fun startPageSurfaceWatch(view: WebView) {
        if (view !== officialWebView || !isTrustedBridgeUrl(view.url)) return
        pageSurfaceWatchGeneration += 1
        handler.removeCallbacks(pageSurfacePoll)
        probeDeepSeekPageSurface(view, pageSurfaceWatchGeneration)
    }

    private fun probeDeepSeekPageSurface(view: WebView, generation: Int) {
        if (view !== officialWebView || isFinishing || isDestroyed) return
        if (generation != pageSurfaceWatchGeneration) return
        if (!isTrustedBridgeUrl(runCatching { view.url }.getOrNull())) {
            handler.removeCallbacks(pageSurfacePoll)
            return
        }
        view.evaluateJavascript(DEEPSEEK_PAGE_SURFACE_PROBE_JS) { raw ->
            if (generation != pageSurfaceWatchGeneration ||
                view !== officialWebView || isFinishing || isDestroyed
            ) return@evaluateJavascript

            val probe = parseDeepSeekPageSurfaceProbe(raw)
            when (probe.surface) {
                DeepSeekPageSurface.CHAT -> {
                    handler.removeCallbacks(pageSurfacePoll)
                    Log.d("SuperDeepSeek", "Chat composer detected; loading Super DeepSeek engine")
                    // Pass the document identity through the asynchronous asset load.
                    // The claim script rechecks both identity and surface before changing page state.
                    injectBdsScripts(view, generation, probe.documentToken)
                    pageFinishedAt = android.os.SystemClock.uptimeMillis()
                    startReadyPoll()
                    syncSystemBarsWithPage()
                    if (bootView == null) scheduleBarRefresh(BAR_REFRESH_THEME_MS)
                }
                DeepSeekPageSurface.AUTH -> {
                    if (!bootDismissed) {
                        Log.d("SuperDeepSeek", "Sign-in/CAPTCHA detected; deferring engine injection")
                        syncSystemBarsWithPage()
                        dismissBoot()
                    }
                    handler.removeCallbacks(pageSurfacePoll)
                    handler.postDelayed(pageSurfacePoll, DEEPSEEK_AUTH_POLL_MS)
                }
                DeepSeekPageSurface.LOADING -> {
                    handler.removeCallbacks(pageSurfacePoll)
                    handler.postDelayed(pageSurfacePoll, DEEPSEEK_PAGE_POLL_MS)
                }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Launch sequence
    //
    //   system splash (launcher icon)  →  BootScreenView (full-screen, native)
    //   → released only when the page is REALLY ready (READY_PROBE_JS: engine
    //     CSS in place, content.js fully run, composer or sign-in form visible),
    //     so the raw official interface is never shown. BOOT_FORCE_DISMISS_MS
    //     is the hard cap for a stalled network.
    // ─────────────────────────────────────────────────────────────────────────

    private var bootView: BootScreenView? = null
    private var bootDismissed = false
    private val engineUiReady = java.util.concurrent.atomic.AtomicBoolean(false)
    /** AndroidBridge.onUiPolished() arrived (the polish pass ran after the engine). */
    private var uiPolished = false
    private var pageFinishedAt = 0L
    private var readyPollRunning = false
    /** Incremented for every main-frame load so stale JS callbacks cannot start the engine. */
    private var pageSurfaceWatchGeneration = 0
    private val pageSurfacePoll: Runnable = Runnable {
        probeDeepSeekPageSurface(officialWebView, pageSurfaceWatchGeneration)
    }

    private companion object {
        /** Native engine modules, in load order (sd-run after sd-agent: it uses its history API; GenUI: protocol → svg → prompt → host → renderer → visuals → artifacts → panel). */
        val NATIVE_MODULES = listOf(
            "sd-native.js", "sd-files.js", "sd-agent.js", "sd-run.js", "sd-sheets.js",
            "sd-genui-protocol.js", "sd-genui-svg.js", "sd-genui-prompt.js", "sd-genui-host.js",
            "sd-genui-frame.js", "sd-genui.js", "sd-genui-viewer.js", "sd-genui-inline.js",
            "sd-genui-visuals.js", "sd-artifacts.js", "sd-genui-mcp.js", "sd-genui-panel.js",
            "sd-health.js"
        )
        const val KEY_ASKED_NOTIFICATIONS = "sd_asked_notifications"
        const val KEY_CHAT_URL = "sd_chat_url"
        const val LIVENESS_TIMEOUT_MS = 8_000L
        /** The page URL when the renderer died; read by the recreated activity. */
        @Volatile var rendererLostUrl: String? = null
        /** Hard cap on the launch screen, however slow the network is. */
        const val BOOT_FORCE_DISMISS_MS = 18_000L
        /** How often the page is probed for readiness while the launch screen is up. */
        const val BOOT_READY_POLL_MS = 300L
        /** If the polish signal never arrives, a ready page is accepted after this. */
        const val BOOT_NO_POLISH_GRACE_MS = 3_000L
        /** Let the engine's first layout settle before revealing the page. */
        const val BOOT_SETTLE_MS = 450L
        /**
         * The chat's dark background until it has been measured on this device
         * (then [storedDarkPageColor] remembers the real value). Matches
         * @color/bds_splash_bg so the splash hand-off is seamless.
         */
        const val PAGE_DARK_DEFAULT = 0xFF1E1F23.toInt()
        const val UI_PREFS = "sd_ui"
        const val PREF_DARK_PAGE_COLOR = "dark_page_color"
        /** Only clearly dark colours are remembered as the chat's dark background. */
        const val DARK_PAGE_MAX_LUMINANCE = 70.0
        /** Re-measure the bars after a theme switch has painted (and settled). */
        val BAR_REFRESH_THEME_MS = longArrayOf(220L, 800L)
        /** Re-measure after a touch: drawers, sheets and navigation change the page. */
        val BAR_REFRESH_TOUCH_MS = longArrayOf(420L, 1000L)
        val BAR_REFRESH_RESUME_MS = longArrayOf(300L, 900L)

        /** "1" once the enhanced chat (or the sign-in form) is actually on screen. */
        val READY_PROBE_JS = """
            (function(){try{
              if(document.readyState!=='complete')return '0';
              if(!document.getElementById('bds-css'))return '0';
              if(typeof window.__sdHandleBack!=='function')return '0';
              var els=document.querySelectorAll('textarea, input:not([type]), input[type=text], input[type=email], input[type=tel], input[type=password]');
              for(var i=0;i<els.length;i++){
                if((els[i].id||'').indexOf('bds-')===0)continue;
                var r=els[i].getBoundingClientRect();
                if(r.width>0&&r.height>0)return '1';
              }
              return '0';
            }catch(e){return '0';}})()
        """.trimIndent()

        /**
         * Background colour ("r,g,b") of the page right under the status bar,
         * ignoring the engine's own overlays; falls back to body / html.
         */
        val PAGE_BG_PROBE_JS = """
            (function(){try{
              function solid(el){
                while(el&&el.nodeType===1){
                  var id=el.id||'', cl=(typeof el.className==='string')?el.className:'';
                  if(id.indexOf('bds-')!==0&&cl.indexOf('bds-')<0){
                    var m=(getComputedStyle(el).backgroundColor||'').match(/rgba?\(([^)]+)\)/);
                    if(m){
                      var p=m[1].split(',');
                      var a=p.length>3?parseFloat(p[3]):1;
                      if(a>0.85)return Math.round(parseFloat(p[0]))+','+Math.round(parseFloat(p[1]))+','+Math.round(parseFloat(p[2]));
                    }
                  }
                  el=el.parentElement;
                }
                return '';
              }
              return solid(document.elementFromPoint(window.innerWidth/2,4))||solid(document.body)||solid(document.documentElement)||'';
            }catch(e){return '';}})()
        """.trimIndent()
    }

    /** Shows the full-screen launch animation above everything else. */
    private fun showNativeBootOverlay() {
        if (bootView != null || bootDismissed) return
        val brandFont = runCatching { resources.getFont(R.font.sd_brand) }.getOrNull()
        val icon = runCatching {
            android.graphics.BitmapFactory.decodeResource(
                resources,
                R.drawable.app_icon,
                android.graphics.BitmapFactory.Options().apply { inScaled = false },
            )
        }.getOrNull()
        val view = BootScreenView(
            this,
            getString(R.string.bds_boot_title),
            brandFont,
            icon,
            baseColor = storedDarkPageColor(),
            splashColor = runCatching { getColor(R.color.bds_splash_bg) }.getOrDefault(PAGE_DARK_DEFAULT),
        ).apply {
            // Swallow touches so nothing reaches the page underneath.
            isClickable = true
            isFocusable = true
        }
        view.onExitFinished = {
            (view.parent as? ViewGroup)?.removeView(view)
            bootView = null
            // The page is fully visible now: paint the bars and measure the exact
            // on-screen colours.
            applyBarColors(pageBarColor, pageNavBarColor)
            mayRememberDarkColor = true
            refreshBarColors()
            handler.postDelayed(barRefreshLate, 700L)
        }
        bootView = view
        findViewById<ViewGroup>(android.R.id.content).addView(
            view,
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
        applySystemBarIcons(PAGE_DARK_DEFAULT, PAGE_DARK_DEFAULT) // light icons over the dark scene
        handler.postDelayed({ forceDismissBoot() }, BOOT_FORCE_DISMISS_MS)
        Log.d("SuperDeepSeek", "Launch screen shown")
    }

    /** Starts (once) the readiness probe loop; it stops when the boot screen is released. */
    private fun startReadyPoll() {
        if (readyPollRunning || bootDismissed || engineUiReady.get()) return
        readyPollRunning = true
        handler.post(readyPoll)
    }

    private val readyPoll: Runnable = object : Runnable {
        override fun run() {
            if (bootDismissed || engineUiReady.get()) {
                readyPollRunning = false
                return
            }
            officialWebView.evaluateJavascript(READY_PROBE_JS) { result ->
                val pageReady = result == "\"1\"" || result == "1"
                val waited = if (pageFinishedAt == 0L) 0L else android.os.SystemClock.uptimeMillis() - pageFinishedAt
                if (pageReady && (uiPolished || waited >= BOOT_NO_POLISH_GRACE_MS)) {
                    readyPollRunning = false
                    markEngineUiReady()
                } else {
                    handler.postDelayed(this, BOOT_READY_POLL_MS)
                }
            }
        }
    }

    /** The enhanced page is on screen: sync the bars, let layout settle, reveal. */
    private fun markEngineUiReady() {
        if (engineUiReady.compareAndSet(false, true)) {
            Log.d("SuperDeepSeek", "Engine UI ready — releasing launch screen")
            syncSystemBarsWithPage()
            handler.postDelayed({ tryDismissBoot() }, BOOT_SETTLE_MS)
        }
    }

    private fun tryDismissBoot() {
        if (engineUiReady.get() && !bootDismissed) dismissBoot()
    }

    private fun forceDismissBoot() {
        if (!bootDismissed) {
            Log.w("SuperDeepSeek", "Launch screen cap reached — revealing the page")
            syncSystemBarsWithPage()
            dismissBoot()
        }
    }

    /** Plays the launch screen's exit (bar completes, zoom + fade); it removes itself. */
    private fun dismissBoot() {
        bootDismissed = true
        val view = bootView
        if (view == null) {
            applyBarColors(pageBarColor, pageNavBarColor)
            return
        }
        view.finish()
    }

    // ─────────────────────────────────────────────────────────────────────────
    // System bars follow the page, like a native app: the strips behind the
    // status and navigation bars take the page's own background colour, and
    // the bar icons turn dark on light pages. The WebView itself stays inside
    // the safe area, so the page header never slides under the status bar.
    //
    // The colour is MEASURED on screen (PixelCopy of a thin strip at the top and
    // bottom edge of the page), not read from CSS: DeepSeek paints its header
    // with gradient fade bands and layered surfaces, so computed styles can be
    // a shade off. While the launch screen is up, a CSS estimate is used.
    // ─────────────────────────────────────────────────────────────────────────

    private val uiPrefs by lazy { getSharedPreferences(UI_PREFS, MODE_PRIVATE) }

    /** The chat's dark background as last measured on this device. */
    private fun storedDarkPageColor(): Int =
        runCatching { uiPrefs.getInt(PREF_DARK_PAGE_COLOR, PAGE_DARK_DEFAULT) }.getOrDefault(PAGE_DARK_DEFAULT)

    /**
     * Set only at trustworthy moments (fresh page right after the launch screen,
     * or just after a switch to dark), cleared by the next touch: a sheet's dim
     * scrim must never be remembered as the page colour.
     */
    private var mayRememberDarkColor = false

    private fun rememberDarkPageColor(color: Int) {
        if (!mayRememberDarkColor || perceivedLuminance(color) > DARK_PAGE_MAX_LUMINANCE) return
        if (color == storedDarkPageColor()) return
        runCatching { uiPrefs.edit().putInt(PREF_DARK_PAGE_COLOR, color).apply() }
    }

    private var pageBarColor = PAGE_DARK_DEFAULT
    private var pageNavBarColor = PAGE_DARK_DEFAULT

    /** One colour for both bars (CSS estimate or theme-switch guess). */
    private fun applyPageBarColor(color: Int) = applyBarColors(color, color)

    private fun applyBarColors(top: Int, bottom: Int) {
        pageBarColor = top
        pageNavBarColor = bottom
        if (::rootLayout.isInitialized) rootLayout.setBackgroundColor(top)
        if (::officialWebView.isInitialized) officialWebView.setBackgroundColor(top)
        // While the launch screen is up the bars stay transparent over its scene.
        if (bootView != null) return
        window.statusBarColor = top
        window.navigationBarColor = bottom
        applySystemBarIcons(top, bottom)
    }

    /** Dark bar icons on light backgrounds, light icons on dark ones. */
    private fun applySystemBarIcons(top: Int, bottom: Int) {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = isLightColor(top)
        controller.isAppearanceLightNavigationBars = isLightColor(bottom)
    }

    /** Best available measurement: on-screen pixels, or the CSS estimate. */
    private fun refreshBarColors() {
        if (bootView == null && sampleBarsFromScreen()) return
        syncSystemBarsWithPage()
    }

    private val barRefresh = Runnable { refreshBarColors() }
    private val barRefreshLate = Runnable { refreshBarColors() }

    /** Debounced re-measure at the given delays (earlier pending ones are replaced). */
    private fun scheduleBarRefresh(delays: LongArray) {
        handler.removeCallbacks(barRefresh)
        handler.removeCallbacks(barRefreshLate)
        handler.postDelayed(barRefresh, delays[0])
        if (delays.size > 1) handler.postDelayed(barRefreshLate, delays[1])
    }

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        val handled = super.dispatchTouchEvent(ev)
        val action = ev.actionMasked
        if (action == MotionEvent.ACTION_DOWN) mayRememberDarkColor = false
        if ((action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) && bootView == null) {
            scheduleBarRefresh(BAR_REFRESH_TOUCH_MS)
        }
        return handled
    }

    private var barSampleBusy = false
    private var stripTop: Bitmap? = null
    private var stripBottom: Bitmap? = null

    /**
     * Copies a thin strip just inside the top and the bottom edge of the page
     * from the window surface and applies the dominant colour of each.
     * Returns false when the page area cannot be measured right now.
     */
    private fun sampleBarsFromScreen(): Boolean {
        if (!::rootLayout.isInitialized || !rootLayout.isAttachedToWindow) return false
        if (barSampleBusy) return true
        val loc = IntArray(2)
        rootLayout.getLocationInWindow(loc)
        val left = loc[0] + rootLayout.paddingLeft
        val right = loc[0] + rootLayout.width - rootLayout.paddingRight
        val pageTop = loc[1] + rootLayout.paddingTop
        val pageBottom = loc[1] + rootLayout.height - rootLayout.paddingBottom
        val density = resources.displayMetrics.density
        val strip = maxOf(1, Math.round(2f * density))
        val gap = maxOf(1, Math.round(1f * density))
        val width = right - left
        if (width <= 0 || pageBottom - pageTop <= 4 * (strip + gap)) return false

        val top = reuseStrip(stripTop, width, strip).also { stripTop = it }
        val bottom = reuseStrip(stripBottom, width, strip).also { stripBottom = it }
        val topRect = Rect(left, pageTop + gap, right, pageTop + gap + strip)
        val bottomRect = Rect(left, pageBottom - gap - strip, right, pageBottom - gap)
        barSampleBusy = true
        try {
            PixelCopy.request(window, topRect, top, topCopy@{ topResult ->
                if (topResult != PixelCopy.SUCCESS || isFinishing || isDestroyed) {
                    barSampleBusy = false
                    return@topCopy
                }
                try {
                    PixelCopy.request(window, bottomRect, bottom, bottomCopy@{ bottomResult ->
                        barSampleBusy = false
                        if (isFinishing || isDestroyed || bootView != null) return@bottomCopy
                        val topColor = dominantColor(pixelsOf(top))
                        val bottomColor = if (bottomResult == PixelCopy.SUCCESS) dominantColor(pixelsOf(bottom)) else null
                        if (topColor == null && bottomColor == null) return@bottomCopy
                        val t = topColor ?: pageBarColor
                        val b = bottomColor ?: t
                        if (t != pageBarColor || b != pageNavBarColor) applyBarColors(t, b)
                        rememberDarkPageColor(t)
                    }, handler)
                } catch (e: IllegalArgumentException) {
                    // The window can lose its backing surface after the first copy's
                    // callback. This asynchronous request is outside the outer try/catch.
                    barSampleBusy = false
                    return@topCopy
                }
            }, handler)
        } catch (e: IllegalArgumentException) {
            // Window not ready for a copy (e.g. no surface yet).
            barSampleBusy = false
            return false
        }
        return true
    }

    private fun reuseStrip(current: Bitmap?, width: Int, height: Int): Bitmap =
        if (current != null && !current.isRecycled && current.width == width && current.height == height) current
        else Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)

    private fun pixelsOf(bitmap: Bitmap): IntArray {
        val px = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(px, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        return px
    }

    /** CSS estimate of the page colour (used while the launch screen covers the page). */
    private fun syncSystemBarsWithPage() {
        if (!::officialWebView.isInitialized) return
        officialWebView.evaluateJavascript(PAGE_BG_PROBE_JS) { result ->
            parseRgb(result)?.let { applyPageBarColor(it) }
        }
    }

    /**
     * Hides entries that are dead in this app (excluded features, upstream
     * chrome, clutter) and keeps them hidden as the engine lazily re-renders.
     * The rules live in [UiPolish] so they are unit-testable.
     */
    private fun injectUiPolish(webView: WebView) {
        webView.evaluateJavascript(UiPolish.buildScript(), null)
    }

    @Volatile private var isForeground = false

    override fun onResume() {
        super.onResume()
        isForeground = true
        cookieManager.flush()
        // The page may have switched theme while we were in the background.
        if (bootView == null && ::rootLayout.isInitialized) scheduleBarRefresh(BAR_REFRESH_RESUME_MS)
        probePageLiveness()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::officialWebView.isInitialized) {
            runCatching { officialWebView.url }.getOrNull()?.let { outState.putString(KEY_CHAT_URL, it) }
        }
    }

    private var livenessToken = 0

    /**
     * Background WebView JS can freeze (seen after minutes in the background
     * even with a foreground service). On return the page must answer a trivial
     * script quickly; if it does not, it is reloaded — same conversation, and
     * the engine picks up a pending tool call from the last reply.
     */
    private fun probePageLiveness() {
        if (!::officialWebView.isInitialized || bootView != null) return
        val token = ++livenessToken
        var answered = false
        runCatching { officialWebView.evaluateJavascript("1") { answered = true } }
        handler.postDelayed({
            if (token != livenessToken || answered || !isForeground || isFinishing) return@postDelayed
            Log.w("SuperDeepSeek", "Page did not answer within ${LIVENESS_TIMEOUT_MS}ms after resume; reloading")
            runCatching { officialWebView.reload() }
        }, LIVENESS_TIMEOUT_MS)
    }

    override fun onPause() {
        super.onPause()
        isForeground = false
        cookieManager.flush()
        if (::bridge.isInitialized) bridge.flushStorageSoon()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingIntent(intent)
    }

    override fun onDestroy() {
        // A recreated activity may already have installed its own handler.
        if (SandboxService.onStopRequested === stopAgentInPage) SandboxService.onStopRequested = null
        if (StudioActivity.onAskAi === askAiInPage) StudioActivity.onAskAi = null
        // Closed for good: no page is left to run the agent loop.
        if (isFinishing) SandboxService.onAgentActiveChanged(this, false)
        handler.removeCallbacksAndMessages(null)
        closePopupWindow()
        try {
            officialWebView.removeJavascriptInterface(BridgeGate.GATE_NAME)
            officialWebView.destroy()
        } catch (_: Exception) {}
        super.onDestroy()
    }

    /** The notification's Stop action: ends the agent loop in the page. */
    private val stopAgentInPage: () -> Unit = {
        if (::officialWebView.isInitialized) {
            officialWebView.post { officialWebView.evaluateJavascript("window.__sdAgent&&window.__sdAgent.stop(true)", null) }
        }
    }

    /**
     * Studio's "Ask the AI": the text goes into the chat's message box (after
     * anything already typed), never sent, and the keyboard stays closed
     * until the user taps the box.
     */
    private val askAiInPage: (String) -> Unit = { text ->
        if (::officialWebView.isInitialized) {
            val js = "(function(){try{var e=window.__sdEngine;if(!e||!e.setComposer)return false;" +
                    "var c=document.querySelector('textarea#chat-input')||document.querySelector('.ds-textarea textarea');" +
                    "var old=c&&c.value?c.value.replace(/\\s+$/,'')+' ':'';" +
                    "return !!e.setComposer(old+${org.json.JSONObject.quote(text)});}catch(x){return false}})()"
            officialWebView.post { officialWebView.evaluateJavascript(js, null) }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Popups (window.open / target=_blank)
    // ─────────────────────────────────────────────────────────────────────────

    private var popupWebView: WebView? = null

    /**
     * Hosts a page-opened window. Sign-in providers (Google) run inside it and
     * close it themselves; anything that is not an in-app host goes to the
     * browser instead and the empty popup is discarded.
     */
    @SuppressLint("SetJavaScriptEnabled")
    private fun openPopupWindow(resultMsg: android.os.Message): Boolean {
        val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
        closePopupWindow()
        val popup = WebView(this)
        popup.layoutParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        popup.setBackgroundColor(pageBarColor)
        popup.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            userAgentString = officialWebView.settings.userAgentString
        }
        cookieManager.setAcceptThirdPartyCookies(popup, true)
        popup.webViewClient = object : WebViewClient() {
            private fun routeOut(view: WebView, url: Uri): Boolean {
                if (!shouldOpenExternally(url, bdsAssetHost)) return false
                openInBrowser(url)
                // Nothing of ours was loaded in it: it was only a new-tab link.
                if (!view.canGoBack()) handler.post { closePopupWindow() }
                return true
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.url?.let { routeOut(view, it) } ?: false
            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                // The first navigation of a new window does not always pass
                // through shouldOverrideUrlLoading.
                val u = url?.let(Uri::parse) ?: return
                if (!view.canGoBack() && shouldOpenExternally(u, bdsAssetHost)) {
                    view.stopLoading()
                    routeOut(view, u)
                }
            }
            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                handler.post { closePopupWindow() }
                return true
            }
        }
        popup.webChromeClient = object : WebChromeClient() {
            override fun onCloseWindow(window: WebView) {
                handler.post { closePopupWindow() }
            }
        }
        rootLayout.addView(popup)
        popupWebView = popup
        transport.webView = popup
        resultMsg.sendToTarget()
        return true
    }

    private fun closePopupWindow() {
        val popup = popupWebView ?: return
        popupWebView = null
        try {
            (popup.parent as? ViewGroup)?.removeView(popup)
            popup.stopLoading()
            popup.destroy()
        } catch (_: Exception) {}
        // A finished sign-in changed the cookies; the opener re-reads them.
        cookieManager.flush()
    }

    private fun openInBrowser(url: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (e: Exception) {
            Log.w("SuperDeepSeek", "No app to open $url", e)
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Downloads started by the page (links with download, attachment responses)
    // ─────────────────────────────────────────────────────────────────────────

    private fun handleWebDownload(url: String, userAgent: String?, contentDisposition: String?, mimeType: String?) {
        val name = android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType)
        maybeAskStoragePermission()
        when {
            url.startsWith("blob:") || url.startsWith("data:") -> {
                // Only the page can read its own blob: URLs; it hands the bytes to
                // the bridge's (background) download writer.
                val js = bridgeGate.shimScript() + "(function(){fetch(${org.json.JSONObject.quote(url)}).then(function(r){return r.blob()})" +
                    ".then(function(b){return new Promise(function(ok,no){var f=new FileReader();f.onload=function(){ok([f.result,b.type])};f.onerror=no;f.readAsDataURL(b)})})" +
                    ".then(function(v){var d=String(v[0]);AndroidBridge.downloadBlob(d.slice(d.indexOf(',')+1),v[1]||${org.json.JSONObject.quote(mimeType ?: "application/octet-stream")},${org.json.JSONObject.quote(name)})})" +
                    ".catch(function(e){console.error('[SD] download failed',e)})})();"
                officialWebView.evaluateJavascript(js, null)
            }
            url.startsWith("http://") || url.startsWith("https://") -> {
                try {
                    val request = android.app.DownloadManager.Request(Uri.parse(url)).apply {
                        setMimeType(mimeType)
                        cookieManager.getCookie(url)?.let { addRequestHeader("Cookie", it) }
                        userAgent?.let { addRequestHeader("User-Agent", it) }
                        setTitle(name)
                        setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                        if (LegacyDownloads.canWriteSharedFolder(this@MainActivity)) {
                            setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, name)
                        } else {
                            setDestinationInExternalFilesDir(this@MainActivity, android.os.Environment.DIRECTORY_DOWNLOADS, name)
                        }
                    }
                    (getSystemService(DOWNLOAD_SERVICE) as android.app.DownloadManager).enqueue(request)
                    android.widget.Toast.makeText(this, getString(R.string.bds_download_started, name), android.widget.Toast.LENGTH_SHORT).show()
                } catch (e: Exception) {
                    Log.w("SuperDeepSeek", "DownloadManager refused $url", e)
                    openInBrowser(Uri.parse(url))
                }
            }
            else -> Log.w("SuperDeepSeek", "Unsupported download URL scheme: ${url.take(16)}")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Renderer loss
    // ─────────────────────────────────────────────────────────────────────────

    private fun recoverFromRendererLoss(view: WebView) {
        if (view !== officialWebView) {
            (view.parent as? ViewGroup)?.removeView(view)
            view.destroy()
            return
        }
        rendererLostUrl = runCatching { view.url }.getOrNull()
        try {
            (view.parent as? ViewGroup)?.removeView(view)
            view.destroy()
        } catch (_: Exception) {}
        if (!RendererCrashGuard.shouldRecover(android.os.SystemClock.elapsedRealtime())) {
            // Crash-looping: do not spin forever.
            finish()
            return
        }
        recreate()
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Shares, shortcuts and deep links → the page
    // ─────────────────────────────────────────────────────────────────────────

    private val pendingPageActions = ArrayList<String>()
    private var engineInjected = false

    private fun handleIncomingIntent(intent: Intent?) {
        val request = parseIncomingIntent(intent) ?: return
        // A recreated Activity must not replay the same share.
        intent?.action = null
        intent?.removeExtra(EXTRA_BDS_ACTION)
        when (request) {
            is IncomingRequest.Shortcut -> deliverPageAction(buildShortcutActionJson(request.action))
            is IncomingRequest.DeepLink -> deliverPageAction(buildDeepLinkActionJson(request.url))
            is IncomingRequest.Share -> {
                if (request.streams.isEmpty()) {
                    deliverPageAction(buildShareActionJson(request.text, emptyList(), emptyList()))
                    return
                }
                // Reading (and sniffing) shared files is I/O: off the main thread.
                val streams = request.streams.take(MAX_SHARED_FILES)
                val overflow = request.streams.drop(MAX_SHARED_FILES)
                Thread {
                    val (files, readSkipped) = bridge.readPickedContentUris(streams, acceptImages = true)
                    val skipped = ArrayList(readSkipped)
                    overflow.forEach { skipped.add(SkippedFile(it.lastPathSegment ?: "file", "file-cap-exceeded")) }
                    val json = buildShareActionJson(request.text, files, skipped)
                    runOnUiThread { deliverPageAction(json) }
                }.start()
            }
        }
    }

    private fun deliverPageAction(actionJson: String) {
        if (!engineInjected || !::officialWebView.isInitialized) {
            pendingPageActions.add(actionJson)
            return
        }
        officialWebView.evaluateJavascript(buildPageActionScript(actionJson), null)
    }

    private fun flushPendingPageActions() {
        engineInjected = true
        if (pendingPageActions.isEmpty()) return
        val queued = ArrayList(pendingPageActions)
        pendingPageActions.clear()
        queued.forEach { officialWebView.evaluateJavascript(buildPageActionScript(it), null) }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // In-app updates (UpdateChecker was written but never called)
    // ─────────────────────────────────────────────────────────────────────────

    private val updateChecker by lazy { UpdateChecker(applicationContext) }

    private fun maybeCheckForUpdate() {
        val checker = updateChecker
        if (!checker.isAutoCheckDue()) return
        Thread {
            val installed = try {
                @Suppress("DEPRECATION")
                val info = packageManager.getPackageInfo(packageName, 0)
                InstalledApp(info.versionName, info.lastUpdateTime, BuildConfig.BUILD_ID)
            } catch (_: Exception) { return@Thread }
            val result = checker.check(installed)
            checker.markChecked()
            if (result is UpdateCheckResult.Available) {
                runOnUiThread { if (!isFinishing && !isDestroyed) showUpdateDialog(result.info, installed) }
            }
        }.start()
    }

    private fun showUpdateDialog(info: UpdateInfo, installed: InstalledApp) {
        val message = if (info.versionName == installed.versionName) {
            // Same version, newer CI build (either channel).
            getString(R.string.bds_update_message_beta, info.versionName)
        } else {
            getString(R.string.bds_update_message, info.versionName, installed.versionName ?: "?")
        }
        android.app.AlertDialog.Builder(this)
            .setTitle(R.string.bds_update_title)
            .setMessage(message)
            .setPositiveButton(R.string.bds_update_download) { _, _ -> downloadAndInstallUpdate(info) }
            .setNegativeButton(R.string.bds_update_later) { _, _ -> updateChecker.rememberDeclined(info.digest) }
            .show()
    }

    private fun downloadAndInstallUpdate(info: UpdateInfo) {
        if (!packageManager.canRequestPackageInstalls()) {
            android.widget.Toast.makeText(this, R.string.bds_update_need_permission, android.widget.Toast.LENGTH_LONG).show()
            try {
                startActivity(Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:$packageName")))
            } catch (_: Exception) {}
            return
        }
        android.widget.Toast.makeText(this, R.string.bds_update_downloading, android.widget.Toast.LENGTH_SHORT).show()
        val target = File(File(cacheDir, "updates").apply { mkdirs() }, "update.apk")
        Thread {
            val failure = updateChecker.downloadApk(info, target)
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                if (failure != null) {
                    android.widget.Toast.makeText(this, getString(R.string.bds_update_download_failed, failure), android.widget.Toast.LENGTH_LONG).show()
                    return@runOnUiThread
                }
                try {
                    val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", target)
                    startActivity(Intent(Intent.ACTION_VIEW)
                        .setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (e: Exception) {
                    Log.w("SuperDeepSeek", "Installer launch failed", e)
                    android.widget.Toast.makeText(this, R.string.bds_update_install_failed, android.widget.Toast.LENGTH_LONG).show()
                }
            }
        }.start()
    }
}
