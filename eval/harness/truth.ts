import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { squashName } from "../../src/gates";

/**
 * Identity of one judged lead: the squashed company name plus a short hash of
 * the signal URL. The unit of judgment is (company, signal_url): two arms can
 * submit the same company on different signals, and each signal is judged on
 * its own.
 */
export function urlHash(signalUrl: string): string {
  return createHash("sha1").update(signalUrl).digest("hex").slice(0, 10);
}

export function truthKey(company: string, signalUrl: string): string {
  return `${squashName(company)}__${urlHash(signalUrl)}`;
}

/**
 * The verdict file for (company, signal_url). The name part of the key depends on
 * squashName, which has changed before ("Avarra.ai" used to be "avarraai"), so: the exact
 * current key first; otherwise any `*__<hash10>.json` whose stored signal_url equals this
 * URL. The hash alone is never enough - the stored URL must match.
 */
export function findVerdictFile(scenarioDir: string, company: string, signalUrl: string): string | undefined {
  const exact = join(scenarioDir, `${truthKey(company, signalUrl)}.json`);
  if (existsSync(exact)) return exact;
  if (!existsSync(scenarioDir)) return undefined;
  const suffix = `__${urlHash(signalUrl)}.json`;
  for (const name of readdirSync(scenarioDir)) {
    if (!name.endsWith(suffix)) continue;
    try {
      const stored = JSON.parse(readFileSync(join(scenarioDir, name), "utf8")) as { signal_url?: unknown };
      if (stored.signal_url === signalUrl) return join(scenarioDir, name);
    } catch {
      // unreadable file: not a match
    }
  }
  return undefined;
}

/** Is an ISO event date inside [now - months, now]? Used before reusing a cached verdict. */
export function eventInWindow(eventDate: string, now: Date, months: number): boolean {
  const event = Date.parse(`${eventDate.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(event)) return false;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCMonth(start.getUTCMonth() - months);
  return event >= start.getTime() && event <= now.getTime();
}
