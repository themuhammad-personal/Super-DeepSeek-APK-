package com.superdeepseek.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import java.io.File

/**
 * Where downloads go on Android 8–9 (API 26–28), which have no MediaStore
 * Downloads collection.
 *
 * Writing to the shared Downloads folder there needs WRITE_EXTERNAL_STORAGE,
 * a runtime permission. Until the user has granted it, files go to the app's
 * own Downloads folder (Android/data/<app>/files/Download), which needs no
 * permission, instead of failing. API 29+ always uses MediaStore.
 */
internal object LegacyDownloads {

    fun canWriteSharedFolder(context: Context): Boolean =
            Build.VERSION.SDK_INT >= 29 ||
                    context.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) ==
                    PackageManager.PERMISSION_GRANTED

    /** The folder a pre-Q download is written to (created if needed). */
    fun folder(context: Context): File {
        @Suppress("DEPRECATION")
        val dir =
                if (canWriteSharedFolder(context)) {
                    Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                } else {
                    context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
                            ?: File(context.filesDir, "Download")
                }
        dir.mkdirs()
        return dir
    }
}

/**
 * [dir]/[name], or name_1, name_2, … (before the extension) when taken.
 * Pure, so the naming rule is unit-testable.
 */
internal fun uniqueFileIn(dir: File, name: String): File {
    val candidate = File(dir, name)
    if (!candidate.exists()) return candidate
    val dot = name.lastIndexOf('.')
    val stem = if (dot > 0) name.substring(0, dot) else name
    val ext = if (dot > 0) name.substring(dot) else ""
    var i = 1
    while (true) {
        val f = File(dir, "${stem}_$i$ext")
        if (!f.exists()) return f
        i++
    }
}
