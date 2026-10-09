package app.loom.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class UnitTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun safeNames() {
        assertEquals("a_b_.txt", safeLocalName("a:b?.txt"))
        assertEquals("trail", safeLocalName("trail. "))
        assertEquals("ok name.jpg", safeLocalName("ok name.jpg"))
    }

    @Test
    fun isoDates() {
        assertEquals(0L, parseIsoMs("1970-01-01T00:00:00.000Z"))
        assertEquals(1_600_000_000_000L, parseIsoMs("2020-09-13T12:26:40.000Z"))
        assertEquals(0L, parseIsoMs(null))
    }

    @Test
    fun walksFoldersWithStructure() {
        val root = File(tmp.root, "Trip")
        File(root, "day 1").mkdirs()
        File(root, "empty").mkdirs()
        File(root, "day 1/a.jpg").writeText("aaa")
        File(root, "b.jpg").writeText("bb")
        File(root, "Thumbs.db").writeText("x")
        val items = mutableListOf<NewItem>()
        JvmFiles().walk(UploadSource(root.path), "Trip") { items += it }
        assertEquals(
            listOf(Triple("dir", "Trip/empty", 0L), Triple("file", "Trip/b.jpg", 2L), Triple("file", "Trip/day 1/a.jpg", 3L)),
            items.map { Triple(it.kind, it.remotePath, it.size) }.sortedBy { it.first + it.second },
        )
    }

    @Test
    fun theQueueSurvivesARestart() {
        val db = File(tmp.root, "q.db")
        var s = Store.open(db)
        val id = s.createBatch(Direction.Upload, "Trip", "Photos", null, OnConflict.Ask)
        s.insertItems(id, OnConflict.Ask, listOf(NewItem("file", "/a", "Trip/a.jpg", 10, 1, null), NewItem("file", "/b", "Trip/b.jpg", 20, 1, OnConflict.Replace)))
        s.setBatchState(id, "active")
        assertEquals(1, s.checking(id, 10).size) // the undecided one waits for the name check
        val picked = s.pick(5, emptyList())
        assertEquals(listOf("Trip/b.jpg"), picked.map { it.remotePath })
        s.setState(picked[0].id, ItemState.Running)
        s.close()
        s = Store.open(db)
        // What was running is queued again.
        assertEquals(ItemState.Queued, s.getItem(picked[0].id)!!.state)
        val t = s.totals()
        assertEquals(30L, t.bytesTotal)
        assertTrue(s.batches(false).single().title == "Trip")
        s.close()
    }
}
