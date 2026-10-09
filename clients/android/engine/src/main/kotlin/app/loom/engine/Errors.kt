package app.loom.engine

/** Errors, sorted by what the engine should do about them. */
sealed class LoomException(message: String, cause: Throwable? = null) : Exception(message, cause) {
    /** Couldn't reach the server, or it answered 5xx / 429 / timed out: wait and try again, forever. */
    class Transient(message: String, cause: Throwable? = null) : LoomException(message, cause)

    /** The device token is gone (removed in Devices, password reset). */
    class SignedOut : LoomException("This device was signed out of Loom")

    /** The server's drive is full. */
    class DiskFull : LoomException("Loom's drive is full")

    /** The upload session expired or was cancelled on the server: start the file again. */
    class SessionGone : LoomException("The upload expired on the server")

    /** The local file changed while it was being sent: start again with the new version. */
    class SourceChanged : LoomException("The file changed while it was being uploaded")

    /** Won't work by retrying (no permission, bad name, file deleted…). */
    class Permanent(message: String, cause: Throwable? = null) : LoomException(message, cause)
}

val Throwable.isTransient get() = this is LoomException.Transient

/** Anything thrown while transferring, as a LoomException. I/O trouble with the network is transient. */
fun Throwable.asLoom(): LoomException = when (this) {
    is LoomException -> this
    is java.net.SocketTimeoutException -> LoomException.Transient("The connection timed out", this)
    is java.net.UnknownHostException, is java.net.ConnectException, is java.net.NoRouteToHostException ->
        LoomException.Transient("Can't reach Loom", this)
    is javax.net.ssl.SSLException -> LoomException.Transient("Secure connection failed: ${message ?: "TLS error"}", this)
    is java.io.FileNotFoundException -> LoomException.Permanent("The file was moved or deleted", this)
    is SecurityException -> LoomException.Permanent("Android didn't allow reading this file", this)
    is java.io.IOException -> LoomException.Transient("Network error: ${message ?: javaClass.simpleName}", this)
    else -> LoomException.Permanent(message ?: javaClass.simpleName, this)
}
