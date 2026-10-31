package com.superdeepseek.app

import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.pdf.PdfRenderer
import android.media.MediaMetadataRetriever
import android.os.ParcelFileDescriptor
import android.util.Base64
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Locale
import kotlin.math.roundToLong

/**
 * Device-side inspection of PDF documents, audio/video containers, and images
 * without sending private user files to any third-party service.
 *
 * Pure JVM header parsers ([parsePdfHeader], [parseWavHeader], [parseMp4Header],
 * [parseImageHeader]) run quickly in memory and are directly unit-testable on the
 * JVM; [inspect] augments them on Android with [PdfRenderer], [MediaMetadataRetriever],
 * [BitmapFactory.Options], and optional offline Tesseract OCR inside the local
 * Alpine Linux sandbox when `/usr/bin/tesseract` is installed.
 */
internal object NativeMediaInspector {

    private const val MAX_INSPECT_BYTES = 50 * 1024 * 1024 // 50 MB cap

    data class PdfHeaderInfo(
        val version: String,
        val pageCount: Int,
        val title: String?,
        val author: String?,
        val encrypted: Boolean,
    )

    data class WavHeaderInfo(
        val formatCode: Int,
        val channels: Int,
        val sampleRate: Int,
        val bitsPerSample: Int,
        val durationMs: Long,
    )

    data class Mp4HeaderInfo(
        val brand: String,
        val durationMs: Long,
        val width: Int,
        val height: Int,
    )

    data class ImageHeaderInfo(
        val format: String,
        val width: Int,
        val height: Int,
    )

    fun parsePdfHeader(bytes: ByteArray): PdfHeaderInfo? {
        if (bytes.size < 8) return null
        val head = String(bytes, 0, minOf(bytes.size, 1024), Charsets.ISO_8859_1)
        val verMatch = Regex("%PDF-(\\d+\\.\\d+)").find(head) ?: return null
        val sampleLen = minOf(bytes.size, 512 * 1024)
        val text = String(bytes, 0, sampleLen, Charsets.ISO_8859_1)
        val counts = Regex("/Type\\s*/Pages\\b[^>]*?/Count\\s+(\\d+)|/Count\\s+(\\d+)[^>]*?/Type\\s*/Pages\\b", setOf(RegexOption.DOT_MATCHES_ALL))
            .findAll(text)
            .mapNotNull { m -> (m.groupValues[1].ifEmpty { m.groupValues[2] }).toIntOrNull() }
            .toList()
        val fallbackPages = Regex("/Type\\s*/Page\\b(?![sS])").findAll(text).count()
        val pageCount = (counts.maxOrNull() ?: fallbackPages).coerceAtLeast(if (fallbackPages > 0) fallbackPages else 0)
        val title = Regex("/Title\\s*\\(([^\\\\)]{1,200})\\)").find(text)?.groupValues?.get(1)?.trim()?.takeIf { it.isNotEmpty() }
        val author = Regex("/Author\\s*\\(([^\\\\)]{1,200})\\)").find(text)?.groupValues?.get(1)?.trim()?.takeIf { it.isNotEmpty() }
        val encrypted = Regex("/Encrypt\\b").containsMatchIn(text)
        return PdfHeaderInfo(
            version = verMatch.groupValues[1],
            pageCount = pageCount,
            title = title,
            author = author,
            encrypted = encrypted,
        )
    }

    fun parseWavHeader(bytes: ByteArray): WavHeaderInfo? {
        if (bytes.size < 44) return null
        if (ascii(bytes, 0, 4) != "RIFF" || ascii(bytes, 8, 4) != "WAVE") return null
        var pos = 12
        var fmtCode = 0
        var channels = 0
        var sampleRate = 0
        var byteRate = 0
        var bitsPerSample = 0
        var dataSize = 0L
        while (pos + 8 <= bytes.size) {
            val id = ascii(bytes, pos, 4)
            val size = u32le(bytes, pos + 4)
            val body = pos + 8
            if (id == "fmt " && size >= 16 && body + 16 <= bytes.size) {
                fmtCode = u16le(bytes, body)
                channels = u16le(bytes, body + 2)
                sampleRate = u32le(bytes, body + 4).toInt()
                byteRate = u32le(bytes, body + 8).toInt()
                bitsPerSample = u16le(bytes, body + 14)
            } else if (id == "data") {
                dataSize = size
                break
            }
            val step = size + (size and 1L)
            if (step < 0 || body + step > bytes.size) break
            pos = (body + step).toInt()
        }
        if (channels <= 0 || sampleRate <= 0) return null
        val effectiveByteRate = if (byteRate > 0) byteRate else sampleRate * channels * maxOf(1, bitsPerSample / 8)
        val durationMs = if (effectiveByteRate > 0 && dataSize > 0) ((dataSize.toDouble() / effectiveByteRate) * 1000.0).roundToLong() else 0L
        return WavHeaderInfo(fmtCode, channels, sampleRate, bitsPerSample, durationMs)
    }

    fun parseMp4Header(bytes: ByteArray): Mp4HeaderInfo? {
        if (bytes.size < 16) return null
        if (ascii(bytes, 4, 4) != "ftyp") return null
        val brand = ascii(bytes, 8, 4).trim()
        var durationMs = 0L
        var maxW = 0
        var maxH = 0

        fun scanBoxes(start: Int, end: Int, depth: Int) {
            if (depth > 6) return
            var pos = start
            val limit = minOf(end, bytes.size)
            while (pos + 8 <= limit) {
                val rawSize = u32be(bytes, pos)
                val type = ascii(bytes, pos + 4, 4)
                var headerLen = 8
                val boxSize: Long = when {
                    rawSize == 1L -> {
                        if (pos + 16 > limit) return
                        headerLen = 16
                        u64be(bytes, pos + 8)
                    }
                    rawSize == 0L -> (limit - pos).toLong()
                    else -> rawSize
                }
                if (boxSize < headerLen || pos + boxSize > limit) break
                val body = pos + headerLen
                val boxEnd = (pos + boxSize).toInt()
                when (type) {
                    "moov", "trak", "mdia" -> scanBoxes(body, boxEnd, depth + 1)
                    "mvhd" -> {
                        if (body + 20 <= boxEnd) {
                            val version = bytes[body].toInt() and 0xFF
                            if (version == 1 && body + 32 <= boxEnd) {
                                val scale = u32be(bytes, body + 20)
                                val dur = u64be(bytes, body + 24)
                                if (scale > 0 && dur > 0) durationMs = ((dur.toDouble() / scale) * 1000.0).roundToLong()
                            } else if (version == 0 && body + 20 <= boxEnd) {
                                val scale = u32be(bytes, body + 12)
                                val dur = u32be(bytes, body + 16)
                                if (scale > 0 && dur > 0) durationMs = ((dur.toDouble() / scale) * 1000.0).roundToLong()
                            }
                        }
                    }
                    "tkhd" -> {
                        val version = if (body < boxEnd) bytes[body].toInt() and 0xFF else 0
                        val widthOff = if (version == 1) body + 88 else body + 76
                        if (widthOff + 8 <= boxEnd) {
                            val w = (u32be(bytes, widthOff) shr 16).toInt()
                            val h = (u32be(bytes, widthOff + 4) shr 16).toInt()
                            if (w > maxW && h > maxH) {
                                maxW = w
                                maxH = h
                            }
                        }
                    }
                }
                pos = boxEnd
            }
        }

        scanBoxes(0, bytes.size, 0)
        return Mp4HeaderInfo(brand = brand, durationMs = durationMs, width = maxW, height = maxH)
    }

    fun parseImageHeader(bytes: ByteArray): ImageHeaderInfo? {
        if (bytes.size < 10) return null
        // PNG
        if (bytes.size >= 24 &&
            (bytes[0].toInt() and 0xFF) == 0x89 &&
            ascii(bytes, 1, 3) == "PNG" &&
            ascii(bytes, 12, 4) == "IHDR"
        ) {
            val w = u32be(bytes, 16).toInt()
            val h = u32be(bytes, 20).toInt()
            if (w > 0 && h > 0) return ImageHeaderInfo("PNG", w, h)
        }
        // GIF
        if (bytes.size >= 10 && (ascii(bytes, 0, 6) == "GIF87a" || ascii(bytes, 0, 6) == "GIF89a")) {
            val w = u16le(bytes, 6)
            val h = u16le(bytes, 8)
            if (w > 0 && h > 0) return ImageHeaderInfo("GIF", w, h)
        }
        // WebP
        if (bytes.size >= 30 && ascii(bytes, 0, 4) == "RIFF" && ascii(bytes, 8, 4) == "WEBP") {
            val chunk = ascii(bytes, 12, 4)
            if (chunk == "VP8X" && bytes.size >= 30) {
                val w = 1 + ((bytes[24].toInt() and 0xFF) or ((bytes[25].toInt() and 0xFF) shl 8) or ((bytes[26].toInt() and 0xFF) shl 16))
                val h = 1 + ((bytes[27].toInt() and 0xFF) or ((bytes[28].toInt() and 0xFF) shl 8) or ((bytes[29].toInt() and 0xFF) shl 16))
                return ImageHeaderInfo("WEBP", w, h)
            } else if (chunk == "VP8 " && bytes.size >= 30) {
                val w = u16le(bytes, 26) and 0x3FFF
                val h = u16le(bytes, 28) and 0x3FFF
                if (w > 0 && h > 0) return ImageHeaderInfo("WEBP", w, h)
            } else if (chunk == "VP8L" && bytes.size >= 25) {
                val b0 = bytes[21].toInt() and 0xFF
                val b1 = bytes[22].toInt() and 0xFF
                val b2 = bytes[23].toInt() and 0xFF
                val b3 = bytes[24].toInt() and 0xFF
                val w = 1 + (b0 or ((b1 and 0x3F) shl 8))
                val h = 1 + (((b1 shr 6) and 0x03) or (b2 shl 2) or ((b3 and 0x0F) shl 10))
                return ImageHeaderInfo("WEBP", w, h)
            }
        }
        // JPEG
        if ((bytes[0].toInt() and 0xFF) == 0xFF && (bytes[1].toInt() and 0xFF) == 0xD8) {
            var pos = 2
            while (pos + 9 < bytes.size) {
                if ((bytes[pos].toInt() and 0xFF) != 0xFF) {
                    pos++
                    continue
                }
                var marker = bytes[pos + 1].toInt() and 0xFF
                while (marker == 0xFF && pos + 2 < bytes.size) {
                    pos++
                    marker = bytes[pos + 1].toInt() and 0xFF
                }
                if (marker == 0xD9 || marker == 0xDA) break
                if (pos + 4 > bytes.size) break
                val segLen = u16be(bytes, pos + 2)
                if (segLen < 2 || pos + 2 + segLen > bytes.size) break
                if (marker in listOf(0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF)) {
                    if (pos + 9 <= bytes.size) {
                        val h = u16be(bytes, pos + 5)
                        val w = u16be(bytes, pos + 7)
                        if (w > 0 && h > 0) return ImageHeaderInfo("JPEG", w, h)
                    }
                }
                pos += 2 + segLen
            }
        }
        return null
    }

    /**
     * Inspects a picked or drag-and-dropped file from either [NativeBlobStore] (`blobPath`)
     * or inline `base64` bytes and populates `meta` + optional offline `ocrText`.
     */
    fun inspect(
        context: Context,
        payload: JSONObject,
        blobs: NativeBlobStore,
        sandbox: Sandbox?,
    ): JSONObject {
        val name = payload.optString("name", "file").trim().ifEmpty { "file" }
        val mime = payload.optString("mime", "").trim().lowercase(Locale.ROOT)
        val ext = name.substringAfterLast('.', "").lowercase(Locale.ROOT)
        val bytes = readPayloadBytes(payload, blobs)
            ?: return JSONObject().put("ok", false).put("error", "Could not read media bytes.")

        val meta = JSONObject()
        meta.put("sizeBytes", bytes.size)
        val kind = classifyKind(mime, ext, bytes)
        meta.put("kind", kind)

        when (kind) {
            "pdf" -> inspectPdf(context, bytes, meta)
            "audio", "video" -> inspectAudioVideo(context, bytes, ext, meta)
            "image" -> inspectImage(context, bytes, ext, sandbox, meta)
        }

        val ocrText = meta.optString("_ocrText", "").trim()
        meta.remove("_ocrText")

        val valid = when (kind) {
            "pdf" -> meta.optInt("pageCount", 0) > 0 || meta.optString("pdfVersion", "").isNotEmpty()
            "audio", "video" ->
                meta.optLong("durationMs", 0L) > 0L ||
                    meta.optInt("sampleRate", 0) > 0 ||
                    meta.optInt("width", 0) > 0 ||
                    meta.optString("container", "").isNotEmpty() ||
                    meta.optString("videoCodec", "").isNotEmpty() ||
                    meta.optString("audioCodec", "").isNotEmpty()
            "image" -> meta.optInt("width", 0) > 0 && meta.optInt("height", 0) > 0
            else -> false
        }

        if (!valid) {
            return JSONObject().put("ok", false).put("error", "Unrecognized or unsupported media stream.")
        }

        return JSONObject()
            .put("ok", true)
            .put("kind", kind)
            .put("meta", meta)
            .apply { if (ocrText.isNotEmpty()) put("ocrText", ocrText) }
    }

    private fun readPayloadBytes(payload: JSONObject, blobs: NativeBlobStore): ByteArray? {
        val blobPath = payload.optString("blobPath", "").trim()
        if (blobPath.isNotEmpty()) {
            val token = parseBlobToken(blobPath) ?: return null
            val entry = blobs.lookup(token) ?: return null
            entry.open()?.use { input ->
                val out = ByteArrayOutputStream()
                val buf = ByteArray(16 * 1024)
                var total = 0
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    total += n
                    if (total > MAX_INSPECT_BYTES) return null
                    out.write(buf, 0, n)
                }
                return out.toByteArray()
            }
        }
        val b64 = payload.optString("base64", "").trim()
        if (b64.isNotEmpty()) {
            return runCatching { Base64.decode(b64, Base64.DEFAULT) }.getOrNull()
        }
        return null
    }

    private fun classifyKind(mime: String, ext: String, bytes: ByteArray): String {
        if (mime == "application/pdf" || ext == "pdf" || parsePdfHeader(bytes) != null) return "pdf"
        if (mime.startsWith("image/") || ext in setOf("png", "jpg", "jpeg", "webp", "gif", "bmp") || parseImageHeader(bytes) != null) return "image"
        if (mime.startsWith("video/") || ext in setOf("mp4", "mov", "m4v", "webm", "mkv", "avi")) return "video"
        if (mime.startsWith("audio/") || ext in setOf("mp3", "wav", "m4a", "aac", "ogg", "opus", "flac")) return "audio"
        return "unknown"
    }

    private fun inspectPdf(context: Context, bytes: ByteArray, meta: JSONObject) {
        parsePdfHeader(bytes)?.let { hdr ->
            meta.put("pdfVersion", hdr.version)
            if (hdr.pageCount > 0) meta.put("pageCount", hdr.pageCount)
            hdr.title?.let { meta.put("title", it) }
            hdr.author?.let { meta.put("author", it) }
            meta.put("encrypted", hdr.encrypted)
        }
        var tmp: File? = null
        try {
            tmp = File.createTempFile("sd-pdf-", ".pdf", context.cacheDir)
            FileOutputStream(tmp).use { it.write(bytes) }
            ParcelFileDescriptor.open(tmp, ParcelFileDescriptor.MODE_READ_ONLY).use { pfd ->
                PdfRenderer(pfd).use { renderer ->
                    meta.put("pageCount", renderer.pageCount)
                    if (renderer.pageCount > 0) {
                        renderer.openPage(0).use { p ->
                            meta.put("pageWidthPt", p.width)
                            meta.put("pageHeightPt", p.height)
                        }
                    }
                }
            }
        } catch (_: Throwable) {
            // Encrypted or non-standard PDFs keep header metadata safely.
        } finally {
            runCatching { tmp?.delete() }
        }
    }

    private fun inspectAudioVideo(context: Context, bytes: ByteArray, ext: String, meta: JSONObject) {
        parseWavHeader(bytes)?.let { wav ->
            meta.put("container", "WAV")
            meta.put("channels", wav.channels)
            meta.put("sampleRate", wav.sampleRate)
            if (wav.bitsPerSample > 0) meta.put("bitsPerSample", wav.bitsPerSample)
            if (wav.durationMs > 0) meta.put("durationMs", wav.durationMs)
        }
        parseMp4Header(bytes)?.let { mp4 ->
            meta.put("container", "ISO BMFF (${mp4.brand})")
            if (mp4.durationMs > 0) meta.put("durationMs", mp4.durationMs)
            if (mp4.width > 0 && mp4.height > 0) {
                meta.put("width", mp4.width)
                meta.put("height", mp4.height)
            }
        }
        var tmp: File? = null
        val retriever = MediaMetadataRetriever()
        try {
            val suffix = if (ext.isNotEmpty()) ".$ext" else ".bin"
            tmp = File.createTempFile("sd-av-", suffix, context.cacheDir)
            FileOutputStream(tmp).use { it.write(bytes) }
            retriever.setDataSource(tmp.absolutePath)
            retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()?.let {
                if (it > 0) meta.put("durationMs", it)
            }
            val w = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
            val h = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
            if (w > 0 && h > 0) {
                meta.put("width", w)
                meta.put("height", h)
            }
            retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE)?.toLongOrNull()?.let {
                if (it > 0) meta.put("bitrateBps", it)
            }
            retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_MIMETYPE)?.takeIf { it.isNotBlank() }?.let {
                meta.put("detectedMime", it)
            }
            retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE)?.takeIf { it.isNotBlank() }?.let {
                meta.put("title", it)
            }
            retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST)?.takeIf { it.isNotBlank() }?.let {
                meta.put("artist", it)
            }
            retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM)?.takeIf { it.isNotBlank() }?.let {
                meta.put("album", it)
            }
            retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CAPTURE_FRAMERATE)?.toDoubleOrNull()?.let {
                if (it > 0.0) meta.put("frameRate", it)
            }
        } catch (_: Throwable) {
            // Keep pure-header parse results if device codec does not recognize the stream.
        } finally {
            runCatching { retriever.release() }
            runCatching { tmp?.delete() }
        }
    }

    private fun inspectImage(context: Context, bytes: ByteArray, ext: String, sandbox: Sandbox?, meta: JSONObject) {
        parseImageHeader(bytes)?.let { img ->
            meta.put("format", img.format)
            meta.put("width", img.width)
            meta.put("height", img.height)
        }
        runCatching {
            val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
            if (opts.outWidth > 0 && opts.outHeight > 0) {
                meta.put("width", opts.outWidth)
                meta.put("height", opts.outHeight)
            }
            opts.outMimeType?.takeIf { it.isNotBlank() }?.let { meta.put("detectedMime", it) }
        }
        // Optional offline OCR via local Alpine sandbox when /usr/bin/tesseract is installed.
        if (sandbox != null && runCatching { sandbox.isInstalled() && sandbox.hostFile("/usr/bin/tesseract")?.canExecute() == true }.getOrDefault(false)) {
            runCatching {
                val safeExt = if (ext in setOf("png", "jpg", "jpeg", "webp", "bmp", "gif")) ext else "png"
                val guestImg = "/tmp/sd-ocr-${System.nanoTime()}.$safeExt"
                val hostImg = sandbox.hostFile(guestImg)
                if (hostImg != null) {
                    hostImg.parentFile?.mkdirs()
                    hostImg.writeBytes(bytes)
                    try {
                        val r = sandbox.exec(
                            "(/usr/bin/tesseract \"\$SD_OCR_IN\" stdout -l eng+ben --psm 3 2>/dev/null || /usr/bin/tesseract \"\$SD_OCR_IN\" stdout -l eng --psm 3 2>/dev/null) | head -c 32768",
                            extraEnv = mapOf("SD_OCR_IN" to guestImg),
                            timeoutSec = 18,
                            announce = false,
                        )
                        val text = r.output.trim()
                        if (r.exitCode == 0 && text.isNotEmpty()) {
                            meta.put("_ocrText", text)
                        }
                    } finally {
                        runCatching { hostImg.delete() }
                    }
                }
            }
        }
    }

    private fun ascii(bytes: ByteArray, offset: Int, len: Int): String {
        if (offset < 0 || offset + len > bytes.size) return ""
        return String(bytes, offset, len, Charsets.ISO_8859_1)
    }

    private fun u16le(b: ByteArray, off: Int): Int =
        (b[off].toInt() and 0xFF) or ((b[off + 1].toInt() and 0xFF) shl 8)

    private fun u16be(b: ByteArray, off: Int): Int =
        ((b[off].toInt() and 0xFF) shl 8) or (b[off + 1].toInt() and 0xFF)

    private fun u32le(b: ByteArray, off: Int): Long =
        (b[off].toLong() and 0xFFL) or
            ((b[off + 1].toLong() and 0xFFL) shl 8) or
            ((b[off + 2].toLong() and 0xFFL) shl 16) or
            ((b[off + 3].toLong() and 0xFFL) shl 24)

    private fun u32be(b: ByteArray, off: Int): Long =
        ((b[off].toLong() and 0xFFL) shl 24) or
            ((b[off + 1].toLong() and 0xFFL) shl 16) or
            ((b[off + 2].toLong() and 0xFFL) shl 8) or
            (b[off + 3].toLong() and 0xFFL)

    private fun u64be(b: ByteArray, off: Int): Long =
        ByteBuffer.wrap(b, off, 8).order(ByteOrder.BIG_ENDIAN).long
}
