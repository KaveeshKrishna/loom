package app.loom.engine

import java.io.File
import java.io.RandomAccessFile

/** Size and modification time of a file to upload. */
data class LocalStat(val size: Long, val mtimeMs: Long)

/**
 * The device's own files, as the engine sees them. On Android these are
 * content:// URIs (what the system picker hands out) and downloads end up
 * in Download/Loom; [JvmFiles] uses plain paths (tests, and the reference
 * for how each call behaves).
 */
interface LocalFiles {
    /** Size and date of a file to upload. Throws Permanent when it's gone or unreadable. */
    fun stat(path: String): LocalStat

    /** Read exactly [len] bytes at [offset] into [buf]. Throws SourceChanged when the file got shorter. */
    fun read(path: String, offset: Long, buf: ByteArray, len: Int)

    /** The name to show for a source (and to use in Loom when no relative path was given). */
    fun name(path: String): String

    /**
     * Walk one upload source: a file gives one item, a folder all its files
     * under [root] (its structure kept), plus each empty folder as a "dir".
     */
    fun walk(source: UploadSource, root: String, emit: (NewItem) -> Unit)

    /** Where a download's bytes collect until it's complete. */
    fun partFile(localPath: String): File

    /** Put a finished download in place (never over an existing file). Returns where it went. */
    fun place(part: File, localPath: String, mtimeMs: Long): String

    /** A child path under a download folder. */
    fun join(dir: String, name: String): String
}

/** Files never worth uploading, and names Loom keeps for itself. */
fun skipName(name: String): Boolean {
    val lower = name.lowercase()
    return lower in setOf("desktop.ini", "thumbs.db", ".ds_store", ".loomtrash", ".tmp-upload", ".nomedia", ".thumbnails") ||
        lower.startsWith(".loom-tmp-") || lower.startsWith("~$") || lower.startsWith(".trashed-") || lower.startsWith(".pending-")
}

/** A name that's valid on Android's storage (FAT/exFAT SD cards are the strictest). */
fun safeLocalName(name: String): String {
    var s = name.map { c -> if (c in "<>:\"/\\|?*" || c.code < 32) '_' else c }.joinToString("")
    s = s.trimEnd('.', ' ')
    return s.ifEmpty { "_" }
}

const val PART_SUFFIX = ".loomdownload"

/** `name.ext`, or `name (1).ext`, … — the first that doesn't exist. */
fun freeName(target: File): File {
    if (!target.exists()) return target
    val name = target.name
    val dot = name.lastIndexOf('.').takeIf { it > 0 } ?: name.length
    val stem = name.substring(0, dot)
    val ext = name.substring(dot)
    return generateSequence(1) { it + 1 }.map { File(target.parentFile, "$stem ($it)$ext") }.first { !it.exists() }
}

/** Plain files and folders. */
open class JvmFiles : LocalFiles {
    override fun stat(path: String): LocalStat {
        val f = File(path)
        if (!f.exists()) throw LoomException.Permanent("The file was moved or deleted")
        if (!f.isFile) throw LoomException.Permanent("This isn't a file any more")
        if (!f.canRead()) throw LoomException.Permanent("This file can't be read")
        return LocalStat(f.length(), f.lastModified())
    }

    override fun read(path: String, offset: Long, buf: ByteArray, len: Int) {
        RandomAccessFile(path, "r").use { f ->
            if (f.length() < offset + len) throw LoomException.SourceChanged()
            f.seek(offset)
            f.readFully(buf, 0, len)
        }
    }

    override fun name(path: String) = File(path).name.ifEmpty { "Untitled" }

    override fun walk(source: UploadSource, root: String, emit: (NewItem) -> Unit) {
        val top = File(source.path)
        if (!top.exists()) return
        if (top.isFile) {
            emit(NewItem("file", top.path, root, top.length(), top.lastModified(), source.conflict))
            return
        }
        // Depth-first, keeping the folder's structure under `root`.
        val stack = ArrayDeque(listOf(top to root))
        while (stack.isNotEmpty()) {
            val (dir, rel) = stack.removeLast()
            val entries = dir.listFiles()?.sortedBy { it.name } ?: continue
            var any = false
            for (e in entries) {
                if (skipName(e.name) || java.nio.file.Files.isSymbolicLink(e.toPath())) continue
                any = true
                val childRel = "$rel/${e.name}"
                if (e.isDirectory) stack.addLast(e to childRel)
                else if (e.isFile) emit(NewItem("file", e.path, childRel, e.length(), e.lastModified(), source.conflict))
            }
            // An empty folder is created as-is.
            if (!any) emit(NewItem("dir", dir.path, rel, 0, 0, null))
        }
    }

    override fun partFile(localPath: String) = File(localPath + PART_SUFFIX)

    override fun place(part: File, localPath: String, mtimeMs: Long): String {
        val target = freeName(File(localPath))
        target.parentFile?.mkdirs()
        if (!part.renameTo(target)) throw LoomException.Permanent("Couldn't save ${target.name}")
        if (mtimeMs > 0) target.setLastModified(mtimeMs)
        return target.path
    }

    override fun join(dir: String, name: String) = File(dir, safeLocalName(name)).path
}
