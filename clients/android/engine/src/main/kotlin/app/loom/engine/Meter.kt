package app.loom.engine

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/** A shared speed limit in bytes per second (0 = none). Blocking: called from the threads that move bytes. */
class Limiter(rate: Long) {
    @Volatile var rate: Long = rate
    private var tokens = rate.toDouble()
    private var last = System.nanoTime()

    /** Wait until [n] bytes may be sent. */
    fun take(n: Int) {
        while (true) {
            val r = rate
            if (r <= 0) return
            val waitMs = synchronized(this) {
                val now = System.nanoTime()
                val burst = r.toDouble() // up to one second's worth
                tokens = minOf(burst, tokens + (now - last) / 1e9 * r)
                last = now
                if (tokens >= n || n > burst) {
                    tokens -= n
                    0L
                } else {
                    ((n - tokens) / r * 1000).toLong().coerceIn(1, 500)
                }
            }
            if (waitMs == 0L) return
            Thread.sleep(waitMs)
        }
    }
}

/** Bytes moved, per item and per batch, plus smoothed speeds. */
class Meter {
    private val total = AtomicLong()
    private val items = ConcurrentHashMap<ItemId, Pair<BatchId, AtomicLong>>()
    private val batchBytes = ConcurrentHashMap<BatchId, AtomicLong>()

    private var lastTotal = 0L
    private var lastBatches = mapOf<BatchId, Long>()
    private var at = 0L
    @Volatile var totalBps = 0.0
        private set
    @Volatile var batchBps: Map<BatchId, Double> = emptyMap()
        private set

    /** Start tracking a running item; returns its live byte counter. */
    fun track(item: ItemId, batch: BatchId, start: Long): AtomicLong {
        val c = AtomicLong(start)
        items[item] = batch to c
        return c
    }

    fun untrack(item: ItemId) {
        items.remove(item)
    }

    /** Live bytes for running items: item → (batch, bytes). */
    fun live(): Map<ItemId, Pair<BatchId, Long>> = items.mapValues { (_, v) -> v.first to v.second.get() }

    /** Count bytes that went over the wire. */
    fun moved(batch: BatchId, n: Long) {
        total.addAndGet(n)
        batchBytes.getOrPut(batch) { AtomicLong() }.addAndGet(n)
    }

    /** Recompute speeds (call a few times a second). */
    @Synchronized
    fun tick() {
        val now = System.nanoTime()
        val t = total.get()
        val batches = batchBytes.mapValues { it.value.get() }
        if (at == 0L) {
            at = now
            lastTotal = t
            lastBatches = batches
            return
        }
        val dt = (now - at) / 1e9
        if (dt < 0.2) return
        fun smooth(old: Double, new: Double) = if (old == 0.0) new else old * 0.6 + new * 0.4
        totalBps = smooth(totalBps, (t - lastTotal) / dt).let { if (it < 1) 0.0 else it }
        val next = HashMap<BatchId, Double>()
        for ((b, bytes) in batches) {
            val v = smooth(batchBps[b] ?: 0.0, (bytes - (lastBatches[b] ?: 0L)) / dt)
            if (v > 1) next[b] = v
        }
        batchBps = next
        lastTotal = t
        lastBatches = batches
        at = now
    }
}
