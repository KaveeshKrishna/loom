//! Speed limit (token bucket) and live progress counters.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::model::{BatchId, ItemId};

/// A shared speed limit in bytes per second (0 = none).
pub struct Limiter {
    rate: AtomicU64,
    state: Mutex<(f64, Instant)>, // (tokens available, last refill)
}

impl Limiter {
    pub fn new(rate: u64) -> Limiter {
        Limiter { rate: AtomicU64::new(rate), state: Mutex::new((rate as f64, Instant::now())) }
    }

    pub fn set_rate(&self, rate: u64) {
        self.rate.store(rate, Ordering::SeqCst);
    }

    pub fn rate(&self) -> u64 {
        self.rate.load(Ordering::SeqCst)
    }

    /// Wait until `n` bytes may be sent.
    pub async fn take(&self, n: usize) {
        loop {
            let rate = self.rate.load(Ordering::SeqCst);
            if rate == 0 {
                return;
            }
            let wait = {
                let mut s = self.state.lock().unwrap();
                let now = Instant::now();
                let burst = rate as f64; // up to one second's worth
                s.0 = (s.0 + now.duration_since(s.1).as_secs_f64() * rate as f64).min(burst);
                s.1 = now;
                if s.0 >= n as f64 || n as f64 > burst {
                    s.0 -= n as f64;
                    None
                } else {
                    Some(Duration::from_secs_f64((n as f64 - s.0) / rate as f64))
                }
            };
            match wait {
                None => return,
                Some(d) => tokio::time::sleep(d.min(Duration::from_millis(500))).await,
            }
        }
    }
}

/// Bytes moved, per item and per batch, plus smoothed speeds.
#[derive(Default)]
pub struct Meter {
    total: AtomicU64,
    items: Mutex<HashMap<ItemId, (BatchId, Arc<AtomicI64>)>>,
    batch_bytes: Mutex<HashMap<BatchId, u64>>,
    speeds: Mutex<Speeds>,
}

#[derive(Default)]
struct Speeds {
    last_total: u64,
    last_batches: HashMap<BatchId, u64>,
    at: Option<Instant>,
    total_bps: f64,
    batch_bps: HashMap<BatchId, f64>,
}

impl Meter {
    /// Start tracking a running item; returns its live byte counter.
    pub fn track(&self, item: ItemId, batch: BatchId, start: i64) -> Arc<AtomicI64> {
        let c = Arc::new(AtomicI64::new(start));
        self.items.lock().unwrap().insert(item, (batch, c.clone()));
        c
    }

    pub fn untrack(&self, item: ItemId) {
        self.items.lock().unwrap().remove(&item);
    }

    /// Live bytes for running items.
    pub fn live(&self) -> HashMap<ItemId, (BatchId, i64)> {
        self.items.lock().unwrap().iter().map(|(k, (b, c))| (*k, (*b, c.load(Ordering::Relaxed)))).collect()
    }

    /// Count bytes that went over the wire.
    pub fn moved(&self, batch: BatchId, n: u64) {
        self.total.fetch_add(n, Ordering::Relaxed);
        *self.batch_bytes.lock().unwrap().entry(batch).or_default() += n;
    }

    /// The speeds from the last tick().
    pub fn speeds(&self) -> (f64, HashMap<BatchId, f64>) {
        let s = self.speeds.lock().unwrap();
        (s.total_bps, s.batch_bps.clone())
    }

    /// Recompute speeds (call a few times a second). Returns (total, per batch) in bytes/second.
    pub fn tick(&self) -> (f64, HashMap<BatchId, f64>) {
        let now = Instant::now();
        let total = self.total.load(Ordering::Relaxed);
        let batches = self.batch_bytes.lock().unwrap().clone();
        let mut s = self.speeds.lock().unwrap();
        if let Some(at) = s.at {
            let dt = now.duration_since(at).as_secs_f64();
            if dt >= 0.2 {
                let smooth = |old: f64, new: f64| if old == 0.0 { new } else { old * 0.6 + new * 0.4 };
                let inst = (total - s.last_total) as f64 / dt;
                s.total_bps = smooth(s.total_bps, inst);
                let mut next = HashMap::new();
                for (b, bytes) in &batches {
                    let prev = s.last_batches.get(b).copied().unwrap_or(0);
                    let v = smooth(s.batch_bps.get(b).copied().unwrap_or(0.0), (*bytes - prev) as f64 / dt);
                    if v > 1.0 {
                        next.insert(*b, v);
                    }
                }
                s.batch_bps = next;
                s.last_total = total;
                s.last_batches = batches;
                s.at = Some(now);
                if s.total_bps < 1.0 {
                    s.total_bps = 0.0;
                }
            }
        } else {
            s.at = Some(now);
            s.last_total = total;
            s.last_batches = batches;
        }
        (s.total_bps, s.batch_bps.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn limiter_holds_the_rate() {
        let l = Limiter::new(200_000);
        let start = Instant::now();
        for _ in 0..10 {
            l.take(64 * 1024).await;
        }
        // 640 KiB at 200 KB/s with a one-second burst: about 2.3 s.
        let t = start.elapsed().as_secs_f64();
        assert!(t > 1.8 && t < 3.5, "took {t}");
    }

    #[tokio::test]
    async fn unlimited_never_waits() {
        let l = Limiter::new(0);
        let start = Instant::now();
        for _ in 0..1000 {
            l.take(1 << 20).await;
        }
        assert!(start.elapsed() < Duration::from_millis(100));
    }
}
