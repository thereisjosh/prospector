import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class LockTimeoutError extends Error {
  constructor(path: string) {
    super(`could not acquire lock ${path}`);
    this.name = "LockTimeoutError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serialise a read-modify-write on one file across concurrent requests (and processes
 * sharing the disk): an O_EXCL lock file with a stale timeout and a bounded retry.
 * A lock older than `staleMs` is assumed to belong to a crashed holder and is reclaimed.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: { staleMs?: number; retryMs?: number } = {},
): Promise<T> {
  const staleMs = options.staleMs ?? 10_000;
  const retryMs = options.retryMs ?? 2_000;
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + retryMs;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(String(process.pid), "utf8");
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const s = await stat(lockPath);
        if (Date.now() - s.mtimeMs > staleMs) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue; // released meanwhile
        throw statError;
      }
      if (Date.now() >= deadline) throw new LockTimeoutError(lockPath);
      await sleep(5 + Math.random() * 20);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}

/** Write via a temp file in the same directory and rename, so readers never see a partial file. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temp, content, "utf8");
  await rename(temp, path);
}
