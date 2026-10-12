import { createHash } from "node:crypto";
import { squashName } from "../../src/gates";

/**
 * Identity of one judged lead: the squashed company name plus a short hash of
 * the signal URL. The unit of judgment is (company, signal_url): two arms can
 * submit the same company on different signals, and each signal is judged on
 * its own.
 */
export function truthKey(company: string, signalUrl: string): string {
  return `${squashName(company)}__${createHash("sha1").update(signalUrl).digest("hex").slice(0, 10)}`;
}

/** Is an ISO event date inside [now - months, now]? Used before reusing a cached verdict. */
export function eventInWindow(eventDate: string, now: Date, months: number): boolean {
  const event = Date.parse(`${eventDate.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(event)) return false;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCMonth(start.getUTCMonth() - months);
  return event >= start.getTime() && event <= now.getTime();
}
