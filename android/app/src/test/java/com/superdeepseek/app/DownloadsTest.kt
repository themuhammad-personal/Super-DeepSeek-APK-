package com.superdeepseek.app

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test

class DownloadsTest {
    private val dir: File = Files.createTempDirectory("dl").toFile()

    @After
    fun cleanup() {
        dir.listFiles()?.forEach { it.delete() }
        dir.delete()
    }

    @Test
    fun `a free name is used as is`() {
        assertEquals(File(dir, "report.pdf"), uniqueFileIn(dir, "report.pdf"))
    }

    @Test
    fun `a taken name gets a counter before the extension`() {
        File(dir, "report.pdf").writeText("x")
        assertEquals("report_1.pdf", uniqueFileIn(dir, "report.pdf").name)
        File(dir, "report_1.pdf").writeText("x")
        assertEquals("report_2.pdf", uniqueFileIn(dir, "report.pdf").name)
    }

    @Test
    fun `names without an extension or starting with a dot get a plain suffix`() {
        File(dir, "Makefile").writeText("x")
        assertEquals("Makefile_1", uniqueFileIn(dir, "Makefile").name)
        File(dir, ".env").writeText("x")
        assertEquals(".env_1", uniqueFileIn(dir, ".env").name)
    }
}
