/**
 * Loom scanner — background worker.
 *
 * Work comes from the scan_jobs table (never from watching the filesystem):
 *   - FULL_RESCAN  (Owner clicks "Scan now")      → rescan lane, one at a time
 *   - PROCESS_FILE (after an upload/edit/rescan)  → processing lane, N in parallel
 *   - INDEX_FILE   (legacy)                        → processing lane
 * Jobs are claimed atomically with SELECT … FOR UPDATE SKIP LOCKED. The web
 * app sends NOTIFY loom_jobs when it queues work, so jobs start within
 * milliseconds; a slow poll is only a fallback.
 *
 * Housekeeping (trash expiry, abandoned uploads, old logs) runs hourly and
 * never walks the media folder, so drives can stay asleep.
 */
import pg from "pg";
import { mkdir, readdir } from "fs/promises";
import { join } from "path";
import { prisma, log, setStatus, THUMB_DIR, PREVIEW_DIR, VIDEO_CACHE_DIR, TEMP_DIR } from "./common.js";
import { runFullRescan, repairParentPaths } from "./rescan.js";
import { processNodeById, indexAndProcessPath } from "./process.js";
import { runMaintenance } from "./maintenance.js";

const CONCURRENCY = Math.max(1, Math.min(8, parseInt(process.env.LOOM_WORKER_CONCURRENCY ?? "2", 10) || 2));
const POLL_MS = 15_000;
const MAINTENANCE_MS = 60 * 60 * 1000;

type Lane = "rescan" | "process";
const LANE_TYPES: Record<Lane, string[]> = {
  rescan: ["FULL_RESCAN"],
  process: ["PROCESS_FILE", "INDEX_FILE"],
};

interface ClaimedJob {
  id: string;
  type: "FULL_RESCAN" | "INDEX_FILE" | "PROCESS_FILE";
  targetPath: string | null;
  fileNodeId: string | null;
}

let stopping = false;
let wakeWaiters: (() => void)[] = [];

function wakeAll() {
  const w = wakeWaiters;
  wakeWaiters = [];
  w.forEach((f) => f());
}

function sleepUntilWoken(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      resolve();
    }
    wakeWaiters.push(done);
  });
}

async function claim(lane: Lane): Promise<ClaimedJob | null> {
  const types = LANE_TYPES[lane];
  const rows = await prisma.$queryRawUnsafe<ClaimedJob[]>(
    `UPDATE "scan_jobs" SET status = 'RUNNING', "startedAt" = now(), attempts = attempts + 1
     WHERE id = (
       SELECT id FROM "scan_jobs"
       WHERE status = 'PENDING' AND type::text = ANY($1::text[])
       ORDER BY "requestedAt" ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, type, "targetPath", "fileNodeId"`,
    types
  );
  return rows[0] ?? null;
}

async function finish(id: string, status: "COMPLETED" | "FAILED", error?: string) {
  await prisma.scanJob
    .updateMany({
      // A job the Owner cancelled meanwhile stays cancelled.
      where: { id, status: "RUNNING" },
      data: { status, completedAt: new Date(), processedFiles: 1, error: error?.slice(0, 2000) },
    })
    .catch(() => {});
}

async function runJob(job: ClaimedJob) {
  try {
    if (job.type === "FULL_RESCAN") {
      await runFullRescan(job.id);
      return; // runFullRescan records its own outcome
    }
    if (job.type === "PROCESS_FILE" && job.fileNodeId) {
      await processNodeById(job.fileNodeId);
    } else if (job.targetPath) {
      await indexAndProcessPath(job.targetPath);
    } else {
      throw new Error("Job has no target");
    }
    await finish(job.id, "COMPLETED");
  } catch (err) {
    log("WARN", `Job ${job.type} ${job.id} failed`, { error: String(err) });
    await finish(job.id, "FAILED", String((err as Error)?.message ?? err));
  }
}

async function laneWorker(lane: Lane, n: number) {
  while (!stopping) {
    let job: ClaimedJob | null = null;
    try {
      job = await claim(lane);
    } catch (err) {
      log("ERROR", `Could not claim a ${lane} job`, { error: String(err) });
    }
    if (job) {
      await runJob(job);
      continue;
    }
    await sleepUntilWoken(POLL_MS + n * 250);
  }
}

async function listenForWakeups() {
  const connect = async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    client.on("notification", () => wakeAll());
    client.on("error", (err) => {
      log("WARN", "LISTEN connection lost — reconnecting", { error: String(err) });
      client.end().catch(() => {});
      setTimeout(() => connect().catch(() => {}), 5_000);
    });
    await client.connect();
    await client.query("LISTEN loom_jobs");
    log("INFO", "Listening for new jobs (LISTEN loom_jobs)");
  };
  await connect().catch((err) => log("WARN", "LISTEN unavailable, falling back to polling", { error: String(err) }));
}

/**
 * loom-web applies database migrations when it starts. After an update the
 * scanner can start first, so wait until every migration it knows about
 * (compose.yml mounts web/prisma, including migrations/) has been applied,
 * rather than failing on columns that don't exist yet.
 */
async function waitForMigrations() {
  let expected: string[];
  try {
    const entries = await readdir(join(process.cwd(), "prisma", "migrations"), { withFileTypes: true });
    expected = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return; // no migrations folder (e.g. local development)
  }
  for (let attempt = 0; ; attempt++) {
    let pending = expected.length;
    try {
      const rows = await prisma.$queryRaw<{ migration_name: string }[]>`
        SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
      const done = new Set(rows.map((r) => r.migration_name));
      pending = expected.filter((n) => !done.has(n)).length;
      if (pending === 0) return;
    } catch {
      /* table not there yet */
    }
    if (attempt % 12 === 0) log("INFO", `Waiting for loom-web to apply database migrations (${pending} pending)`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

async function main() {
  log("INFO", `Loom scanner starting (processing concurrency: ${CONCURRENCY})`);
  try {
    for (const d of [THUMB_DIR, PREVIEW_DIR, VIDEO_CACHE_DIR, TEMP_DIR]) await mkdir(d, { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      log("ERROR", "Can't write to the cache folder. It must be writable by uid 1000. On the host run: sudo chown -R 1000:1000 <your LOOM_CACHE_PATH>", { error: String(err) });
      process.exit(1);
    }
    throw err;
  }

  await waitForMigrations();
  await repairParentPaths();

  // Jobs left RUNNING by a crash or restart go back to the queue.
  const recovered = await prisma.scanJob.updateMany({ where: { status: "RUNNING" }, data: { status: "PENDING" } });
  if (recovered.count) log("INFO", `Re-queued ${recovered.count} interrupted job(s)`);
  await setStatus("scanner_status", "idle");

  const beat = () => setStatus("scanner_heartbeat", new Date().toISOString());
  await beat();
  setInterval(beat, 30_000).unref();

  await listenForWakeups();
  await runMaintenance();
  setInterval(() => runMaintenance(), MAINTENANCE_MS).unref();

  const workers = [laneWorker("rescan", 0)];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(laneWorker("process", i + 1));
  await Promise.all(workers);
}

async function shutdown() {
  log("INFO", "Scanner shutting down");
  stopping = true;
  wakeAll();
  await setStatus("scanner_status", "idle");
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch(async (err) => {
  log("ERROR", "Fatal scanner error", { error: String(err) });
  await prisma.$disconnect();
  process.exit(1);
});
