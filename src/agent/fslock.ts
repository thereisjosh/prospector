import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class LockTimeoutError extends Error {
  constructor(path: string) {
    super(`could not acquire lock ${path}`);
    this.name = "LockTimeoutError";
  }
}

export type FileLockOptions = {
  /** Total time a caller may wait (in-process queue + disk lock) before LockTimeoutError. Default 10 s. */
  deadlineMs?: number;
  /** A lock is reclaimed only when older than this AND its recorded pid is not alive. Default 30 s. */
  staleMs?: number;
  /** @deprecated alias of deadlineMs. */
  retryMs?: number;
};

export const DEFAULT_LOCK_DEADLINE_MS = 10_000;
export const DEFAULT_LOCK_STALE_MS = 30_000;
const BACKOFF_MIN_MS = 5;
const BACKOFF_MAX_MS = 100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with jitter: attempt 0 -> 5 ms, doubling, capped at 100 ms; each wait is uniform in [d/2, d]. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(attempt, 10));
  return ceiling / 2 + random() * (ceiling / 2);
}

/* In-process FIFO queue per lock path. Contenders inside one process wait here in order instead of
 * polling the disk (which saturated the 4-thread libuv pool and let unlucky waiters starve). The
 * disk lock below still arbitrates between processes. */
type Queue = { waiters: Array<() => void> };
const queues = new Map<string, Queue>();

async function enterQueue(path: string, deadline: number): Promise<void> {
  const queue = queues.get(path);
  if (!queue) {
    queues.set(path, { waiters: [] });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const grant = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      const i = queue.waiters.indexOf(grant);
      if (i >= 0) queue.waiters.splice(i, 1);
      reject(new LockTimeoutError(path));
    }, Math.max(0, deadline - Date.now()));
    queue.waiters.push(grant);
  });
}

function leaveQueue(path: string): void {
  const queue = queues.get(path);
  const next = queue?.waiters.shift();
  if (next) next(); // hand the slot straight to the oldest waiter
  else queues.delete(path);
}

type LockBody = { pid: number; ts: number; token: string };

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // exists, not ours
  }
}

async function readBody(path: string): Promise<LockBody | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<LockBody>;
    if (typeof raw.pid === "number" && typeof raw.ts === "number" && typeof raw.token === "string") return raw as LockBody;
  } catch {
    /* missing, empty (writer between create and write) or legacy format */
  }
  return undefined;
}

/** Dead holder = old enough AND (recorded pid not alive, or no readable pid and the file mtime is also old). */
async function isStale(path: string, staleMs: number): Promise<boolean> {
  const body = await readBody(path);
  if (body) return Date.now() - body.ts > staleMs && !pidAlive(body.pid);
  const s = await stat(path);
  return Date.now() - s.mtimeMs > staleMs;
}

async function acquireDisk(path: string, deadline: number, staleMs: number): Promise<string> {
  const token = randomBytes(8).toString("hex");
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now(), token } satisfies LockBody), "utf8");
      } finally {
        await handle.close();
      }
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      if (await isStale(path, staleMs)) {
        await rm(path, { force: true });
        continue;
      }
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue; // released meanwhile
      throw statError;
    }
    if (Date.now() >= deadline) throw new LockTimeoutError(path);
    await sleep(Math.min(backoffMs(attempt), Math.max(1, deadline - Date.now())));
  }
}

/** Remove the lock only if it is still ours (a reclaimed-and-retaken lock belongs to someone else). */
async function releaseDisk(path: string, token: string): Promise<void> {
  const body = await readBody(path);
  if (body && body.token !== token) return;
  await rm(path, { force: true });
}

/**
 * Serialise a read-modify-write on one file across concurrent requests (and processes sharing the
 * disk). In-process callers queue FIFO; across processes an O_EXCL lock file records pid+timestamp.
 * Waiting uses exponential backoff with jitter (5 -> 100 ms) up to `deadlineMs` (default 10 s: a
 * waiting request beats a 500). A lock is reclaimed only after `staleMs` (default 30 s) AND when its
 * pid is dead, so a slow holder is never mistaken for a crashed one. Always released in finally.
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const deadline = Date.now() + (options.deadlineMs ?? options.retryMs ?? DEFAULT_LOCK_DEADLINE_MS);
  await mkdir(dirname(lockPath), { recursive: true });
  await enterQueue(lockPath, deadline);
  try {
    const token = await acquireDisk(lockPath, deadline, staleMs);
    try {
      return await fn();
    } finally {
      await releaseDisk(lockPath, token);
    }
  } finally {
    leaveQueue(lockPath);
  }
}

/** Write via a temp file in the same directory and rename, so readers never see a partial file. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temp, content, "utf8");
  await rename(temp, path);
}
