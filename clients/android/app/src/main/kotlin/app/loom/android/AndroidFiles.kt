package app.loom.android

import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import app.loom.engine.JvmFiles
import app.loom.engine.LocalStat
import app.loom.engine.LoomException
import app.loom.engine.NewItem
import app.loom.engine.UploadSource
import app.loom.engine.freeName
import app.loom.engine.safeLocalName
import app.loom.engine.sha256Hex
import app.loom.engine.skipName
import java.io.File
import java.io.FileInputStream
import java.io.IOException

/**
 * The phone's files for the engine:
 * - uploads read content:// URIs from the system picker (access kept across
 *   restarts) or copies in the app's own storage (shared and dropped files);
 * - downloads collect in the app's storage and are then saved to
 *   Download/Loom (MediaStore on Android 10+, the folder itself before).
 */
class AndroidFiles(private val context: Context) : JvmFiles() {
    private val resolver get() = context.contentResolver

    /** Downloads go here, under Download/. */
    val downloadRoot = "Loom"

    private fun isUri(path: String) = path.startsWith("content://")

    override fun stat(path: String): LocalStat {
        if (!isUri(path)) return super.stat(path)
        val uri = Uri.parse(path)
        try {
            resolver.query(uri, null, null, null, null)?.use { c ->
                if (!c.moveToFirst()) throw LoomException.Permanent("The file was moved or deleted")
                val size = c.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 && !c.isNull(it) }?.let { c.getLong(it) }
                val modified = c.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED).takeIf { it >= 0 && !c.isNull(it) }?.let { c.getLong(it) }
                    ?: c.getColumnIndex(MediaStore.MediaColumns.DATE_MODIFIED).takeIf { it >= 0 && !c.isNull(it) }?.let { c.getLong(it) * 1000 }
                    ?: 0L
                return LocalStat(size ?: fdSize(uri), modified)
            } ?: throw LoomException.Permanent("The file was moved or deleted")
        } catch (e: SecurityException) {
            throw LoomException.Permanent("Loom no longer has access to this file. Choose it again.")
        } catch (e: IllegalArgumentException) {
            throw LoomException.Permanent("The file was moved or deleted")
        }
    }

    private fun fdSize(uri: Uri): Long = resolver.openFileDescriptor(uri, "r")?.use { it.statSize } ?: 0L

    override fun read(path: String, offset: Long, buf: ByteArray, len: Int) {
        if (!isUri(path)) return super.read(path, offset, buf, len)
        val uri = Uri.parse(path)
        try {
            val pfd = resolver.openFileDescriptor(uri, "r") ?: throw LoomException.Permanent("The file was moved or deleted")
            pfd.use {
                FileInputStream(it.fileDescriptor).use { input ->
                    val ch = input.channel
                    // Most providers hand out a real file; a few only a stream that can't seek.
                    if (runCatching { ch.position(offset) }.isFailure) {
                        var skip = offset
                        while (skip > 0) {
                            val n = input.skip(skip)
                            if (n <= 0) throw LoomException.SourceChanged()
                            skip -= n
                        }
                    }
                    var o = 0
                    while (o < len) {
                        val n = input.read(buf, o, len - o)
                        if (n < 0) throw LoomException.SourceChanged()
                        o += n
                    }
                }
            }
        } catch (e: java.io.FileNotFoundException) {
            throw LoomException.Permanent("The file was moved or deleted")
        } catch (e: SecurityException) {
            throw LoomException.Permanent("Loom no longer has access to this file. Choose it again.")
        } catch (e: IOException) {
            throw LoomException.Transient("Couldn't read the file: ${e.message}")
        }
    }

    override fun name(path: String): String {
        if (!isUri(path)) return super.name(path)
        val uri = Uri.parse(path)
        if (DocumentsContract.isTreeUri(uri) && !DocumentsContract.isDocumentUri(context, uri)) {
            val doc = DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri))
            return queryName(doc) ?: DocumentsContract.getTreeDocumentId(uri).substringAfterLast('/').substringAfterLast(':').ifEmpty { "Folder" }
        }
        return queryName(uri) ?: uri.lastPathSegment?.substringAfterLast('/') ?: "Untitled"
    }

    private fun queryName(uri: Uri): String? = runCatching {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
    }.getOrNull()

    override fun walk(source: UploadSource, root: String, emit: (NewItem) -> Unit) {
        if (!isUri(source.path)) return super.walk(source, root, emit)
        val uri = Uri.parse(source.path)
        if (!(DocumentsContract.isTreeUri(uri) && !DocumentsContract.isDocumentUri(context, uri))) {
            val st = stat(source.path)
            emit(NewItem("file", source.path, root, st.size, st.mtimeMs, source.conflict))
            return
        }
        // A folder chosen with the system's folder picker: walk it, keeping its structure.
        val stack = ArrayDeque(listOf(DocumentsContract.getTreeDocumentId(uri) to root))
        val cols = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        )
        while (stack.isNotEmpty()) {
            val (docId, rel) = stack.removeLast()
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(uri, docId)
            var any = false
            val rows = mutableListOf<Array<Any?>>()
            resolver.query(children, cols, null, null, null)?.use { c ->
                while (c.moveToNext()) rows += arrayOf(c.getString(0), c.getString(1), c.getString(2), if (c.isNull(3)) 0L else c.getLong(3), if (c.isNull(4)) 0L else c.getLong(4))
            }
            for (r in rows.sortedBy { it[1] as String }) {
                val name = r[1] as String
                if (skipName(name)) continue
                any = true
                val childRel = "$rel/$name"
                if (r[2] == DocumentsContract.Document.MIME_TYPE_DIR) {
                    stack.addLast(r[0] as String to childRel)
                } else {
                    val doc = DocumentsContract.buildDocumentUriUsingTree(uri, r[0] as String)
                    emit(NewItem("file", doc.toString(), childRel, r[3] as Long, r[4] as Long, source.conflict))
                }
            }
            if (!any) emit(NewItem("dir", "", rel, 0, 0, null))
        }
    }

    // ── downloads ────────────────────────────────────────────────────────────

    override fun partFile(localPath: String): File {
        val dir = File(context.getExternalFilesDir(null) ?: context.filesDir, "partial").apply { mkdirs() }
        return File(dir, sha256Hex(localPath.toByteArray()).take(32) + ".part")
    }

    /** [localPath] is relative to Download/, e.g. "Loom/Album/photo.jpg". */
    override fun place(part: File, localPath: String, mtimeMs: Long): String {
        val name = localPath.substringAfterLast('/')
        val folder = localPath.substringBeforeLast('/', "")
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                    put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/$folder")
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                    if (mtimeMs > 0) put(MediaStore.MediaColumns.DATE_MODIFIED, mtimeMs / 1000)
                }
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw LoomException.Permanent("Android didn't let Loom save $name")
                try {
                    resolver.openOutputStream(uri)?.use { out -> part.inputStream().use { it.copyTo(out, 256 * 1024) } }
                        ?: throw LoomException.Permanent("Android didn't let Loom save $name")
                    resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
                } catch (e: Exception) {
                    resolver.delete(uri, null, null)
                    throw e
                }
                part.delete()
                return uri.toString()
            }
            @Suppress("DEPRECATION")
            val target = freeName(File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), localPath))
            target.parentFile?.mkdirs()
            if (!part.renameTo(target)) {
                part.inputStream().use { input -> target.outputStream().use { input.copyTo(it, 256 * 1024) } }
                part.delete()
            }
            if (mtimeMs > 0) target.setLastModified(mtimeMs)
            MediaScannerConnection.scanFile(context, arrayOf(target.path), null, null)
            return target.path
        } catch (e: LoomException) {
            throw e
        } catch (e: SecurityException) {
            throw LoomException.Permanent("Android didn't let Loom save to Downloads")
        } catch (e: IOException) {
            throw LoomException.Transient("Couldn't save $name: ${e.message}")
        }
    }

    override fun join(dir: String, name: String) = if (dir.isEmpty()) safeLocalName(name) else "$dir/${safeLocalName(name)}"

    /** Shared and dropped files are copied here first (their access ends when the sharing app's grant does). */
    fun incomingDir(): File = File(context.filesDir, "incoming").apply { mkdirs() }

    /** Copy [uris] into a fresh folder of the app's own storage; returns the copies. */
    fun copyIn(uris: List<Uri>, progress: (Int) -> Unit = {}): List<File> {
        val dir = File(incomingDir(), System.currentTimeMillis().toString(36) + "-" + (0..9999).random()).apply { mkdirs() }
        val used = HashSet<String>()
        return uris.mapIndexedNotNull { i, uri ->
            progress(i)
            runCatching {
                var name = safeLocalName(queryName(uri) ?: "Shared file")
                var n = 1
                val base = name.substringBeforeLast('.', name)
                val ext = name.substring(base.length)
                while (!used.add(name.lowercase())) name = "$base (${n++})$ext"
                val out = File(dir, name)
                resolver.openInputStream(uri)?.use { input -> out.outputStream().use { input.copyTo(it, 256 * 1024) } } ?: return@runCatching null
                // Keep the original date where the provider tells it.
                val modified = runCatching { stat(uri.toString()).mtimeMs }.getOrDefault(0L)
                if (modified > 0) out.setLastModified(modified)
                out
            }.getOrNull()
        }
    }

    /** Remove copies that no unfinished upload needs any more. */
    fun cleanIncoming(stillNeeded: Collection<String>) {
        val keep = stillNeeded.toHashSet()
        val recent = System.currentTimeMillis() - 10 * 60_000
        incomingDir().listFiles()?.forEach { dir ->
            if (dir.lastModified() > recent) return@forEach // may not be queued yet
            val files = dir.walkTopDown().filter { it.isFile }.toList()
            if (files.none { it.path in keep }) dir.deleteRecursively()
        }
    }
}
