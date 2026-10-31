package com.superdeepseek.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

class NativeMediaInspectorTest {

    @Test
    fun `parsePdfHeader extracts version page count metadata and encryption flag`() {
        val raw = """
            %PDF-1.6
            1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
            2 0 obj << /Type /Pages /Count 12 >> endobj
            3 0 obj << /Title (Super DeepSeek Architecture) /Author (Muhammad) >> endobj
            4 0 obj << /Encrypt 5 0 R >> endobj
            %%EOF
        """.trimIndent().toByteArray(Charsets.ISO_8859_1)

        val info = NativeMediaInspector.parsePdfHeader(raw)
        assertNotNull(info)
        assertEquals("1.6", info!!.version)
        assertEquals(12, info.pageCount)
        assertEquals("Super DeepSeek Architecture", info.title)
        assertEquals("Muhammad", info.author)
        assertTrue(info.encrypted)

        assertNull(NativeMediaInspector.parsePdfHeader("not a pdf".toByteArray()))
    }

    @Test
    fun `parseWavHeader parses PCM channels sampleRate bitsPerSample and duration`() {
        val sampleRate = 48_000
        val channels = 2
        val bitsPerSample = 16
        val byteRate = sampleRate * channels * (bitsPerSample / 8)
        val dataSize = byteRate * 4 // 4 seconds
        val buf = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        buf.put("RIFF".toByteArray(Charsets.US_ASCII))
        buf.putInt(36 + dataSize)
        buf.put("WAVE".toByteArray(Charsets.US_ASCII))
        buf.put("fmt ".toByteArray(Charsets.US_ASCII))
        buf.putInt(16)
        buf.putShort(1) // PCM
        buf.putShort(channels.toShort())
        buf.putInt(sampleRate)
        buf.putInt(byteRate)
        buf.putShort((channels * (bitsPerSample / 8)).toShort())
        buf.putShort(bitsPerSample.toShort())
        buf.put("data".toByteArray(Charsets.US_ASCII))
        buf.putInt(dataSize)

        val info = NativeMediaInspector.parseWavHeader(buf.array())
        assertNotNull(info)
        assertEquals(1, info!!.formatCode)
        assertEquals(2, info.channels)
        assertEquals(48_000, info.sampleRate)
        assertEquals(16, info.bitsPerSample)
        assertEquals(4_000L, info.durationMs)
    }

    @Test
    fun `parseMp4Header parses ftyp brand mvhd duration and tkhd dimensions`() {
        val ftyp = ByteBuffer.allocate(20).order(ByteOrder.BIG_ENDIAN).apply {
            putInt(20)
            put("ftyp".toByteArray(Charsets.US_ASCII))
            put("isom".toByteArray(Charsets.US_ASCII))
            putInt(0)
            putInt(0)
        }.array()

        val mvhd = ByteBuffer.allocate(32).order(ByteOrder.BIG_ENDIAN).apply {
            putInt(32)
            put("mvhd".toByteArray(Charsets.US_ASCII))
            putInt(0) // version 0 + flags
            putInt(0) // creation
            putInt(0) // modification
            putInt(1000) // timescale = 1000
            putInt(6500) // duration = 6500ms
            putInt(0)
        }.array()

        val tkhd = ByteBuffer.allocate(92).order(ByteOrder.BIG_ENDIAN).apply {
            putInt(92)
            put("tkhd".toByteArray(Charsets.US_ASCII))
            position(8 + 76)
            putInt(1920 shl 16)
            putInt(1080 shl 16)
        }.array()

        val trak = ByteBuffer.allocate(8 + tkhd.size).order(ByteOrder.BIG_ENDIAN).apply {
            putInt(8 + tkhd.size)
            put("trak".toByteArray(Charsets.US_ASCII))
            put(tkhd)
        }.array()

        val moov = ByteBuffer.allocate(8 + mvhd.size + trak.size).order(ByteOrder.BIG_ENDIAN).apply {
            putInt(8 + mvhd.size + trak.size)
            put("moov".toByteArray(Charsets.US_ASCII))
            put(mvhd)
            put(trak)
        }.array()

        val mp4 = ByteArrayOutputStream().apply {
            write(ftyp)
            write(moov)
        }.toByteArray()

        val info = NativeMediaInspector.parseMp4Header(mp4)
        assertNotNull(info)
        assertEquals("isom", info!!.brand)
        assertEquals(6_500L, info.durationMs)
        assertEquals(1920, info.width)
        assertEquals(1080, info.height)

        assertNull(NativeMediaInspector.parseMp4Header(byteArrayOf(0, 0, 0, 24)))
    }

    @Test
    fun `parseImageHeader detects PNG GIF WEBP and JPEG dimensions`() {
        val png = ByteBuffer.allocate(24).order(ByteOrder.BIG_ENDIAN).apply {
            put(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
            putInt(13)
            put("IHDR".toByteArray(Charsets.US_ASCII))
            putInt(1024)
            putInt(768)
        }.array()
        val pngInfo = NativeMediaInspector.parseImageHeader(png)
        assertNotNull(pngInfo)
        assertEquals("PNG", pngInfo!!.format)
        assertEquals(1024, pngInfo.width)
        assertEquals(768, pngInfo.height)

        val gif = ByteBuffer.allocate(10).order(ByteOrder.LITTLE_ENDIAN).apply {
            put("GIF89a".toByteArray(Charsets.US_ASCII))
            putShort(320)
            putShort(240)
        }.array()
        val gifInfo = NativeMediaInspector.parseImageHeader(gif)
        assertNotNull(gifInfo)
        assertEquals("GIF", gifInfo!!.format)
        assertEquals(320, gifInfo.width)
        assertEquals(240, gifInfo.height)

        val jpeg = ByteBuffer.allocate(20).order(ByteOrder.BIG_ENDIAN).apply {
            put(0xFF.toByte()); put(0xD8.toByte()) // SOI
            put(0xFF.toByte()); put(0xC0.toByte()) // SOF0
            putShort(11) // segment length
            put(8) // precision
            putShort(640) // height
            putShort(480) // width
        }.array()
        val jpgInfo = NativeMediaInspector.parseImageHeader(jpeg)
        assertNotNull(jpgInfo)
        assertEquals("JPEG", jpgInfo!!.format)
        assertEquals(480, jpgInfo.width)
        assertEquals(640, jpgInfo.height)
        assertFalse(jpgInfo.width <= 0)
    }
}
