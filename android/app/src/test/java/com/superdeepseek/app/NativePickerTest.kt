package com.superdeepseek.app

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.provider.MediaStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The engine's "+" sheet asks for a picker by mode (`AndroidBridge.pickFiles`).
 * Each card must reach the right Android picker: Camera → camera app,
 * Photos → gallery (never the Files browser), Files → any-file picker,
 * Folder → document tree.
 */
@RunWith(RobolectricTestRunner::class)
class NativePickerTest {

    @Test
    fun `each sheet mode maps to its picker`() {
        assertEquals(NativePickKind.CAMERA, nativePickKind("camera"))
        assertEquals(NativePickKind.PHOTOS, nativePickKind("images"))
        assertEquals(NativePickKind.FOLDER, nativePickKind("folder"))
        assertEquals(NativePickKind.FOLDER, nativePickKind("folder+images"))
        assertEquals(NativePickKind.FILES, nativePickKind("files"))
        // The Files card: still the generic file picker, images merely accepted.
        assertEquals(NativePickKind.FILES, nativePickKind("files+images"))
        assertEquals(NativePickKind.FILES, nativePickKind("banana"))
    }

    @Test
    fun `image acceptance follows the mode`() {
        assertTrue(nativePickAcceptsImages("camera"))
        assertTrue(nativePickAcceptsImages("images"))
        assertTrue(nativePickAcceptsImages("files+images"))
        assertTrue(nativePickAcceptsImages("folder+images"))
        assertFalse(nativePickAcceptsImages("files"))
        assertFalse(nativePickAcceptsImages("folder"))
    }

    @Test
    fun `camera intent captures straight into the given output uri`() {
        val out = Uri.parse("content://com.example.fileprovider/cache/capture-1.jpg")
        val intent = buildCameraIntent(out)

        assertEquals(MediaStore.ACTION_IMAGE_CAPTURE, intent.action)
        @Suppress("DEPRECATION")
        assertEquals(out, intent.getParcelableExtra<Uri>(MediaStore.EXTRA_OUTPUT))
        assertTrue(intent.flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION != 0)
    }

    @Test
    fun `gallery fallback opens media store images, not the documents browser`() {
        val intent = buildGalleryFallbackIntent()

        assertEquals(Intent.ACTION_PICK, intent.action)
        assertEquals(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, intent.data)
        assertEquals("image/*", intent.type)
        assertTrue(intent.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false))
        assertFalse(intent.categories?.contains(Intent.CATEGORY_OPENABLE) == true)
    }

    @Test
    fun `files card uses the generic any-file picker`() {
        val intent = buildFileChooserIntent(null, true)

        assertEquals(Intent.ACTION_GET_CONTENT, intent.action)
        assertEquals("*/*", intent.type)
    }

    @Test
    fun `parsePickedUris collects multi-select and single results without duplicates`() {
        val a = Uri.parse("content://media/picker/0/1")
        val b = Uri.parse("content://media/picker/0/2")
        val data = Intent().apply {
            clipData = ClipData.newRawUri("", a).apply { addItem(ClipData.Item(b)) }
            setData(a)
        }

        assertEquals(listOf(a, b), parsePickedUris(data))
        assertEquals(emptyList<Uri>(), parsePickedUris(null))
    }
}
