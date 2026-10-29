package com.superdeepseek.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class EngineStoreTest {
    private fun tempDir(): File = Files.createTempDirectory("engine-store").toFile()

    @Test
    fun valuesSurviveARestart() {
        val dir = tempDir()
        val a = EngineStore(dir, writeDelayMs = 0)
        a.put("bds_settings", "x".repeat(5000))
        a.put("bds_memories", "[1,2,3]")
        a.flushNow()

        val b = EngineStore(dir, writeDelayMs = 0)
        assertEquals("x".repeat(5000), b.get("bds_settings"))
        assertEquals("[1,2,3]", b.get("bds_memories"))
        assertTrue(b.has("bds_settings"))
        assertNull(b.get("missing"))
        assertFalse(b.has("missing"))
    }

    @Test
    fun theLatestWriteWinsAndRemoveDeletesTheFile() {
        val dir = tempDir()
        val s = EngineStore(dir, writeDelayMs = 50)
        repeat(20) { s.put("k", "v$it") }
        assertEquals("v19", s.get("k"))
        s.flushNow()
        assertEquals("v19", EngineStore(dir).get("k"))

        s.remove("k")
        assertNull(s.get("k"))
        assertFalse(s.has("k"))
        s.flushNow()
        assertNull(EngineStore(dir).get("k"))
        assertEquals(0, dir.listFiles()!!.count { !it.name.endsWith(".tmp") })
    }

    @Test
    fun keysNeverBecomePaths() {
        val dir = tempDir()
        val s = EngineStore(dir, writeDelayMs = 0)
        s.put("../../evil", "v")
        s.flushNow()
        assertEquals(listOf(EngineStore.fileName("../../evil")), dir.list()!!.toList())
        assertEquals(64, EngineStore.fileName("../../evil").length)
    }

    @Test
    fun worksWithoutADirectory() {
        val s = EngineStore(null, writeDelayMs = 0)
        s.put("k", "v")
        assertEquals("v", s.get("k"))
        s.flushNow()
    }

    @Test
    fun flushSoonWritesWithoutWaitingForTheDelay() {
        val dir = tempDir()
        val s = EngineStore(dir, writeDelayMs = 60_000)
        s.put("k", "v")
        s.flushSoon()
        val deadline = System.currentTimeMillis() + 5_000
        val file = File(dir, EngineStore.fileName("k"))
        while (!file.exists() && System.currentTimeMillis() < deadline) Thread.sleep(20)
        assertEquals("v", file.readText())
    }

    @Test
    fun aFailedWriteKeepsTheValueAndIsRetried() {
        val parent = tempDir()
        val blocker = File(parent, "store")
        blocker.writeText("not a directory")
        val s = EngineStore(blocker, writeDelayMs = 0)
        s.put("k", "v1")
        s.flushNow()
        assertEquals("v1", s.get("k"))
        blocker.delete()
        s.put("k", "v2")
        s.flushNow()
        assertEquals("v2", File(blocker, EngineStore.fileName("k")).readText())
    }
}
