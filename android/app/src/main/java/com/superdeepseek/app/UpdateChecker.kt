package com.superdeepseek.app

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * In-app update support for the Android shell.
 *
 * Two channels are offered, both backed by the GitHub Releases that
 * `.github/workflows/build-and-release-apk.yml` publishes:
 *
 * - [UpdateChannel.RELEASE] (the default) reads `GET /repos/{owner}/{repo}/releases/latest`, the
 *   release GitHub marks as latest. CI publishes every build with `make_latest: true` — a `v*` tag
 *   or the continuously rebuilt `latest` tag — so this is always the newest published build.
 * - [UpdateChannel.BETA] reads `GET /repos/{owner}/{repo}/releases/tags/latest`, the continuous
 *   build itself, even while a newer tagged release is marked latest.
 *
 * The releases API exposes the APK's `browser_download_url`, its `sha256:` digest, size and upload
 * time; the release body carries the CI build number ([parseBuildId]).
 *
 * The decision helpers below are top-level `internal` functions so they can be unit-tested on the
 * JVM without a device.
 */
internal enum class UpdateChannel(val storageValue: String) {
    RELEASE("release"),
    BETA("beta");

    companion object {
        internal val DEFAULT = RELEASE

        /** Unknown or missing values fall back to the stable channel. */
        internal fun from(raw: String?): UpdateChannel {
            val normalized = raw?.trim()?.lowercase()
            return UpdateChannel.values().firstOrNull { it.storageValue == normalized } ?: DEFAULT
        }
    }
}

/** Where the update metadata for [channel] lives, relative to the GitHub API base URL. */
internal fun releaseApiPath(channel: UpdateChannel, owner: String, repo: String): String =
        when (channel) {
            UpdateChannel.RELEASE -> "/repos/$owner/$repo/releases/latest"
            UpdateChannel.BETA -> "/repos/$owner/$repo/releases/tags/latest"
        }

/**
 * Read a leading dotted numeric version, tolerating a `v` prefix and any suffix: `v0.1.14`,
 * `0.1.14` and `v0.1.14-hotfix` all yield `[0, 1, 14]`. Returns null when nothing numeric can be
 * read, which callers must treat as "unknown", never as "older".
 */
internal fun parseVersion(raw: String?): List<Int>? {
    val match = Regex("""(\d+(?:\.\d+)*)""").find(raw ?: "") ?: return null
    val parts = match.groupValues[1].split('.').mapNotNull { it.toIntOrNull() }
    return parts.ifEmpty { null }
}

/** Compare two dotted versions, returning a negative value, zero, or a positive value. */
internal fun compareVersions(a: List<Int>, b: List<Int>): Int {
    val size = maxOf(a.size, b.size)
    for (index in 0 until size) {
        val diff = (a.getOrNull(index) ?: 0) - (b.getOrNull(index) ?: 0)
        if (diff != 0) return diff
    }
    return 0
}

/**
 * Pick the Android APK out of a release's asset list.
 *
 * CI publishes one APK per release, `super-deepseek-latest.apk`; an asset whose name starts
 * with `super-deepseek` wins, otherwise the first other `.apk` is taken (older releases). Only
 * assets the API reports as `uploaded` and that have a download URL are eligible.
 */
internal fun pickApkAsset(assets: JSONArray?): JSONObject? {
    if (assets == null) return null
    var fallbackAsset: JSONObject? = null
    for (index in 0 until assets.length()) {
        val asset = assets.optJSONObject(index) ?: continue
        val name = asset.optString("name")
        if (!name.endsWith(".apk", ignoreCase = true) || name.endsWith(".sha256", ignoreCase = true)) continue
        val state = asset.optString("state", "uploaded")
        if (state != "uploaded") continue
        if (asset.optString("browser_download_url").isBlank()) continue
        if (name.startsWith("super-deepseek", ignoreCase = true)) {
            return asset
        }
        if (fallbackAsset == null) {
            fallbackAsset = asset
        }
    }
    return fallbackAsset
}

/**
 * Extract the lowercase hex digest from a release asset's `digest` field, which the API formats as
 * `sha256:<64 hex chars>`. Returns null for anything else, including the empty field older assets
 * carry.
 */
internal fun parseSha256Digest(raw: String?): String? {
    val value = raw?.trim() ?: return null
    if (!value.startsWith(SHA256_PREFIX, ignoreCase = true)) return null
    val hex = value.substring(SHA256_PREFIX.length).trim().lowercase()
    if (hex.length != SHA256_HEX_LENGTH) return null
    return hex.takeIf { candidate -> candidate.all { it in '0'..'9' || it in 'a'..'f' } }
}

/**
 * Whether the release described by the arguments should be offered to the user.
 *
 * Version comes first and outranks every other signal, on both channels: a release the installed
 * build already matches, or one older than it, is never offered — downgrades are impossible
 * without uninstalling. The version is read from the release tag, which is this project's own
 * convention (`v0.1.14`).
 *
 * When the versions tie, two signals are left:
 *
 * 1. **CI build numbers** ([remoteBuildId] against [installedBuildId]), on both channels. Every
 *    push to `main` rebuilds the same `versionCode`/`versionName` and republishes it as the latest
 *    release, so a per-build identity is the only way to keep receiving those builds. It compares
 *    two integers produced by the same counter, so no clocks are involved and nothing can drift.
 * 2. **Upload time against install time**, beta channel only, used when either build number is 0 —
 *    releases published before the ids existed, and APKs built outside CI. This one is a
 *    heuristic: the two timestamps come from different clocks, so a device clock that lags can
 *    hide a newer build, and installing a stale APK late can do the same. The stable channel
 *    does not guess and stays quiet instead.
 *
 * [declinedDigest] records the build the user already answered "Later" to, so a single dismissal
 * is not re-asked on every launch while that same build is current.
 */
internal fun decideUpdate(
        channel: UpdateChannel,
        remoteVersionName: String?,
        installedVersionName: String?,
        remoteBuildId: Long,
        installedBuildId: Long,
        remoteUploadedAtMillis: Long,
        installedLastUpdateTimeMillis: Long,
        remoteDigest: String?,
        declinedDigest: String?,
): UpdateDecision {
    val remoteVersion = parseVersion(remoteVersionName)
    val installedVersion = parseVersion(installedVersionName)

    if (remoteVersion != null && installedVersion != null) {
        val order = compareVersions(remoteVersion, installedVersion)
        if (order < 0) return UpdateDecision(false, REASON_INSTALLED_NEWER)
        if (order > 0) return UpdateDecision(true, REASON_NEWER_VERSION)
    } else if (channel == UpdateChannel.RELEASE) {
        // Without two comparable versions the stable channel cannot tell a newer build from the
        // installed one, so it stays silent rather than nagging about a build the user has.
        return UpdateDecision(false, REASON_NO_VERSION_INFO)
    }

    val newerBuild = remoteBuildId > 0L && installedBuildId > 0L && remoteBuildId > installedBuildId
    if (channel != UpdateChannel.BETA && !newerBuild) return UpdateDecision(false, REASON_UP_TO_DATE)

    if (remoteDigest != null && remoteDigest == declinedDigest) {
        return UpdateDecision(false, REASON_DECLINED)
    }

    // Clock-free path. Taken whenever both sides know their build number.
    if (remoteBuildId > 0L && installedBuildId > 0L) {
        return if (newerBuild) {
            UpdateDecision(true, REASON_NEWER_BUILD_ID)
        } else {
            UpdateDecision(false, REASON_UP_TO_DATE)
        }
    }

    if (remoteUploadedAtMillis <= 0L || installedLastUpdateTimeMillis <= 0L) {
        return UpdateDecision(false, REASON_NO_TIMESTAMP)
    }
    return if (remoteUploadedAtMillis > installedLastUpdateTimeMillis) {
        UpdateDecision(true, REASON_NEWER_BUILD)
    } else {
        UpdateDecision(false, REASON_UP_TO_DATE)
    }
}

internal data class UpdateDecision(val available: Boolean, val reason: String)

/**
 * The locally installed package, as far as update decisions are concerned.
 *
 * [buildId] is `BuildConfig.BUILD_ID`, the CI run number the APK was built with, or 0 for a build
 * that did not come from CI.
 */
internal data class InstalledApp(
        val versionName: String?,
        val lastUpdateTimeMillis: Long,
        val buildId: Long,
)

/** A downloadable update. */
internal data class UpdateInfo(
        val channel: UpdateChannel,
        val versionName: String,
        val downloadUrl: String,
        val digest: String?,
        val sizeBytes: Long,
        val uploadedAtMillis: Long,
)

internal sealed class UpdateCheckResult {
    data class Available(val info: UpdateInfo) : UpdateCheckResult()

    data class UpToDate(val reason: String) : UpdateCheckResult()

    data class Failed(val error: String) : UpdateCheckResult()
}

/**
 * Checks GitHub Releases for a newer Android build and downloads it.
 *
 * The channel and the last declined digest live in the same `SharedPreferences` file the JS bridge
 * uses, so both survive process death and app updates.
 *
 * `internal` on purpose: every method in the update surface speaks in the internal
 * [UpdateChannel] / [UpdateInfo] / [UpdateCheckResult] vocabulary, and a public class may not
 * expose internal types in its signatures.
 */
internal class UpdateChecker(
        context: Context,
        httpClient: OkHttpClient? = null,
        private val apiBaseUrl: String = DEFAULT_API_BASE_URL,
        private val owner: String = DEFAULT_REPO_OWNER,
        private val repo: String = DEFAULT_REPO_NAME,
) {

    private val prefs: SharedPreferences =
            context.getSharedPreferences(WebViewBridge.PREFS_NAME, Context.MODE_PRIVATE)

    /**
     * Deliberately not the bridge's shared client: that one caps the whole call at 120 s, which a
     * 6 MB APK download can exceed on a slow mobile connection. The read timeout here is per-read,
     * so a stalled connection still fails while a slow one is allowed to finish.
     */
    private val httpClient: OkHttpClient =
            httpClient
                    ?: OkHttpClient.Builder()
                            .connectTimeout(20, TimeUnit.SECONDS)
                            .readTimeout(60, TimeUnit.SECONDS)
                            .build()

    /** Returns the selected channel, defaulting to [UpdateChannel.DEFAULT]. */
    fun getChannel(): UpdateChannel = UpdateChannel.from(prefs.getString(KEY_CHANNEL, null))

    /** Persists the selected channel and clears any dismissal from the other channel. */
    fun setChannel(channel: UpdateChannel) {
        prefs.edit()
                .putString(KEY_CHANNEL, channel.storageValue)
                .remove(KEY_DECLINED_DIGEST)
                .apply()
    }

    /** Records the build the user dismissed so the same one is not offered again. */
    fun rememberDeclined(digest: String?) {
        if (digest.isNullOrBlank()) return
        prefs.edit().putString(KEY_DECLINED_DIGEST, digest).apply()
    }

    /**
     * True when an automatic check is due. Launching the app repeatedly must not burn through the
     * unauthenticated GitHub API budget (60 requests per hour per IP), so automatic checks are
     * spaced by [AUTO_CHECK_INTERVAL_MS]. Manual checks bypass this.
     */
    fun isAutoCheckDue(nowMillis: Long = System.currentTimeMillis()): Boolean {
        val last = prefs.getLong(KEY_LAST_CHECK_AT, 0L)
        return nowMillis - last >= AUTO_CHECK_INTERVAL_MS
    }

    /** Stamps the throttle window. Call after any completed check, successful or not. */
    fun markChecked(nowMillis: Long = System.currentTimeMillis()) {
        prefs.edit().putLong(KEY_LAST_CHECK_AT, nowMillis).apply()
    }

    /**
     * Fetch the release for the active channel and decide whether it should be offered.
     *
     * Never throws: network, parsing and rate-limit problems come back as
     * [UpdateCheckResult.Failed] so a startup check can stay silent.
     */
    fun check(installed: InstalledApp): UpdateCheckResult {
        val channel = getChannel()
        val path = releaseApiPath(channel, owner, repo)
        val url = apiBaseUrl.trimEnd('/') + path

        val request =
                Request.Builder()
                        .url(url)
                        .header("Accept", "application/vnd.github+json")
                        .header("User-Agent", USER_AGENT)
                        .get()
                        .build()

        val body =
                try {
                    httpClient.newCall(request).execute().use { response ->
                        if (!response.isSuccessful) {
                            val remaining = response.header("x-ratelimit-remaining")
                            return UpdateCheckResult.Failed(
                                    if (remaining == "0") "github-rate-limited"
                                    else "http-${response.code}"
                            )
                        }
                        response.body?.string().orEmpty()
                    }
                } catch (t: Throwable) {
                    Log.w(TAG, "Update check failed for $url", t)
                    return UpdateCheckResult.Failed("network")
                }

        val release =
                try {
                    JSONObject(body)
                } catch (t: Throwable) {
                    Log.w(TAG, "Update check returned unparseable JSON", t)
                    return UpdateCheckResult.Failed("malformed-response")
                }

        if (release.optBoolean("draft", false)) {
            return UpdateCheckResult.Failed("draft-release")
        }

        val asset = pickApkAsset(release.optJSONArray("assets"))
        if (asset == null) {
            return UpdateCheckResult.Failed("no-apk-asset")
        }

        val versionName = releaseVersionName(release.optString("tag_name"), release.optString("body", ""))
        val digest = parseSha256Digest(asset.optString("digest", ""))
        val uploadedAt = parseIso8601Millis(asset.optString("updated_at", ""))
        val buildId = parseBuildId(release.optString("body", ""))

        val decision =
                decideUpdate(
                        channel = channel,
                        remoteVersionName = versionName,
                        installedVersionName = installed.versionName,
                        remoteBuildId = buildId,
                        installedBuildId = installed.buildId,
                        remoteUploadedAtMillis = uploadedAt,
                        installedLastUpdateTimeMillis = installed.lastUpdateTimeMillis,
                        remoteDigest = digest,
                        declinedDigest = prefs.getString(KEY_DECLINED_DIGEST, null),
                )

        if (!decision.available) {
            return UpdateCheckResult.UpToDate(decision.reason)
        }

        return UpdateCheckResult.Available(
                UpdateInfo(
                        channel = channel,
                        versionName = versionName,
                        downloadUrl = asset.optString("browser_download_url"),
                        digest = digest,
                        sizeBytes = asset.optLong("size", 0L),
                        uploadedAtMillis = uploadedAt,
                )
        )
    }

    /**
     * Stream [info]'s APK into [target], verifying its sha256 while writing.
     *
     * Returns null on success, or a short machine-readable reason on failure. The digest is checked
     * before the file is handed to the package installer; a mismatch deletes the file rather than
     * offering it.
     */
    fun downloadApk(info: UpdateInfo, target: File): String? {
        val request =
                Request.Builder()
                        .url(info.downloadUrl)
                        .header("Accept", "application/octet-stream")
                        .header("User-Agent", USER_AGENT)
                        .get()
                        .build()

        var failure: String? = null
        try {
            httpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    failure = "http-${response.code}"
                    return@use
                }
                val source = response.body?.byteStream()
                if (source == null) {
                    failure = "empty-body"
                    return@use
                }

                val digest = MessageDigest.getInstance("SHA-256")
                target.parentFile?.mkdirs()
                var written = 0L
                target.outputStream().use { sink ->
                    val buffer = ByteArray(DOWNLOAD_BUFFER_BYTES)
                    while (true) {
                        val read = source.read(buffer)
                        if (read < 0) break
                        if (read == 0) continue
                        digest.update(buffer, 0, read)
                        sink.write(buffer, 0, read)
                        written += read
                    }
                }
                // Older assets carry no digest: then at least the size must match, so a
                // connection cut mid-way is not handed to the installer as a broken APK.
                if (!isCompleteDownload(written, info.sizeBytes)) {
                    Log.w(TAG, "APK size mismatch: expected ${info.sizeBytes}, got $written")
                    target.delete()
                    failure = "incomplete"
                    return@use
                }

                val expected = info.digest
                if (expected != null) {
                    val actual =
                            digest.digest().joinToString("") { byte ->
                                "%02x".format(byte.toInt() and 0xFF)
                            }
                    if (!actual.equals(expected, ignoreCase = true)) {
                        Log.w(TAG, "APK digest mismatch: expected $expected, got $actual")
                        target.delete()
                        failure = "digest-mismatch"
                    }
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "APK download failed", t)
            target.delete()
            failure = "network"
        }
        return failure
    }

    companion object {
        private const val TAG = "BdsUpdateChecker"

        private const val DEFAULT_API_BASE_URL = "https://api.github.com"
        private const val DEFAULT_REPO_OWNER = "themuhammad-personal"
        private const val DEFAULT_REPO_NAME = "Super-Deepseek-"

        /**
         * GitHub's API rejects requests without a User-Agent and asks integrators to identify
         * themselves. Sending a distinct value keeps this traffic distinguishable from the
         * browser-fingerprint UA the fetch bridge uses.
         */
        private const val USER_AGENT = "SuperDeepSeek-Android"

        internal const val KEY_CHANNEL = "bds_update_channel"
        internal const val KEY_DECLINED_DIGEST = "bds_update_declined_digest"
        internal const val KEY_LAST_CHECK_AT = "bds_update_last_check_at"

        /** Automatic checks are spaced out to stay inside the unauthenticated API budget. */
        internal val AUTO_CHECK_INTERVAL_MS = TimeUnit.HOURS.toMillis(6)

        internal const val DOWNLOAD_BUFFER_BYTES = 64 * 1024
    }
}

internal const val APK_ASSET_PREFIX = "better-deepseek-android-"
internal const val APK_ASSET_SUFFIX = "-signed.apk"
internal const val SHA256_PREFIX = "sha256:"
internal const val SHA256_HEX_LENGTH = 64

/**
 * Marker the CI workflow writes into the release body, inside an HTML comment so it stays
 * invisible in the rendered release notes.
 */
internal const val BUILD_ID_PATTERN = """bds-build-id:\s*(\d+)"""

/** The visible "**Build:** `123`" line of the release notes, for releases without the marker. */
internal const val BUILD_LINE_PATTERN = """\*\*Build:\*\*\s*`(\d+)`"""

internal const val REASON_INSTALLED_NEWER = "installed-is-newer"
internal const val REASON_NEWER_VERSION = "newer-version"
internal const val REASON_NO_VERSION_INFO = "no-version-info"
internal const val REASON_UP_TO_DATE = "up-to-date"
internal const val REASON_DECLINED = "declined"
internal const val REASON_NO_TIMESTAMP = "no-timestamp"
internal const val REASON_NEWER_BUILD = "newer-build"
internal const val REASON_NEWER_BUILD_ID = "newer-build-id"

/**
 * Read the CI build number out of a release body.
 *
 * Returns 0 when the release carries no id, which callers must treat as "unknown" rather than
 * "older": the tagged releases are published without one, and so are APKs built outside CI.
 */
/**
 * The version a release carries. Tagged releases (`v2.70.0`) name it in the tag. The continuous
 * build that every push to `main` publishes is always tagged `latest`, so its version comes from
 * the `**Version:** `x.y.z`` line the workflow writes into the release notes. The release title
 * ("Continuous Build #12") is never used: its run number would be misread as a version.
 */
internal fun releaseVersionName(tag: String?, body: String?): String {
    val fromTag = (tag ?: "").removePrefix("v")
    if (Regex("""^\d+(?:\.\d+)+""").containsMatchIn(fromTag)) return fromTag
    val fromBody = Regex(VERSION_LINE_PATTERN).find(body ?: "")?.groupValues?.get(1)
    return fromBody ?: fromTag
}

internal const val VERSION_LINE_PATTERN = """\*\*Version:\*\*\s*`v?(\d+(?:\.\d+)+)`"""

internal fun parseBuildId(raw: String?): Long {
    val text = raw ?: return 0L
    val match = Regex(BUILD_ID_PATTERN).find(text) ?: Regex(BUILD_LINE_PATTERN).find(text) ?: return 0L
    return match.groupValues[1].toLongOrNull() ?: 0L
}

/** A download is complete when its size matches the asset's, or the asset reports no size. */
internal fun isCompleteDownload(written: Long, expected: Long): Boolean =
        expected <= 0L || written == expected

/**
 * Parse the ISO-8601 timestamps the releases API returns (`2026-09-16T12:35:49Z`) into epoch
 * millis, or 0 when the value is missing or unparseable. The format is fixed, so it is parsed
 * strictly by hand: anything else (offsets, fractions) is rejected rather than guessed at.
 */
internal fun parseIso8601Millis(raw: String?): Long {
    val value = raw?.trim() ?: return 0L
    // \z rather than $ so the pattern carries no dollar sign inside a Kotlin raw string.
    val match = Regex("""^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z\z""").find(value)
            ?: return 0L
    val (year, month, day, hour, minute, second) = match.destructured
    val calendar =
            java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC")).apply {
                clear()
                set(
                        year.toInt(),
                        month.toInt() - 1,
                        day.toInt(),
                        hour.toInt(),
                        minute.toInt(),
                        second.toInt(),
                )
            }
    return calendar.timeInMillis
}
