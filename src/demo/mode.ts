import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDirs } from "../agent/config";

/**
 * Demo mode: the product runs on recorded data so a reviewer can use it with
 * no API keys. On when DEMO_MODE=1 or NEXT_PUBLIC_DEMO=1, or when either key
 * is missing (a live call could not succeed anyway).
 */
export function isDemoMode(): boolean {
  if (isPausedByFile()) return true;
  if (process.env.DEMO_MODE === "1" || process.env.NEXT_PUBLIC_DEMO === "1") return true;
  if (process.env.LIVE_MODE === "off" || Number(process.env.DAILY_SPEND_CAP_DOLLARS) === 0) return true;
  return !process.env.ANTHROPIC_API_KEY || !process.env.EXA_API_KEY;
}

export function pausedFile(): string {
  return join(resolveDataDirs().data, "paused");
}

export function isPausedByFile(): boolean {
  return existsSync(pausedFile());
}

/** Fixtures live in eval/demo (override with DEMO_DIR). Read per request so new recordings drop in. */
export function demoDir(): string {
  return process.env.DEMO_DIR ?? join(process.cwd(), "eval", "demo");
}

export async function readDemoJson<T>(...parts: string[]): Promise<T> {
  return JSON.parse(await readFile(join(demoDir(), ...parts), "utf8")) as T;
}

export const DEMO_RUN_PREFIX = "demo-";

export function isDemoRunId(id: string): boolean {
  return id.startsWith(DEMO_RUN_PREFIX);
}

/** Short artificial pause so a replayed turn feels like a turn, not a dump. */
export function demoDelay(ms = 750): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
