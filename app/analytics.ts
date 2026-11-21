/**
 * Product analytics (PostHog US, through the same-origin /ingest proxy in next.config.mjs).
 * This is the only module that imports posthog-js. Components import `track`; every call is a
 * no-op until `initAnalytics` has run with a key, so with NEXT_PUBLIC_POSTHOG_KEY unset nothing
 * loads and nothing is sent. Never put API keys, the workspace id, cookies or lead contact
 * details (names, emails of people) in event properties.
 */
import type { PostHog } from "posthog-js";

export type AnalyticsEvent =
  | "seller_submitted"
  | "profile_confirmed"
  | "plan_built"
  | "run_started"
  | "run_decision"
  | "run_finished"
  | "run_error"
  | "evidence_opened"
  | "csv_downloaded"
  | "lead_feedback"
  | "new_search"
  | "adjust_targeting";

export type AnalyticsProps = Record<string, string | number | boolean | null | undefined>;

export const SELLER_TEXT_CAP = 500;

let client: PostHog | null = null;
let starting: Promise<boolean> | null = null;
/** run_finished is reported once per run id, whatever re-renders, resumes or reloads of a finished run follow. */
const reportedRuns = new Set<string>();

/**
 * Starts PostHog once. No key (unset, empty or blank) or no browser: stays off and posthog-js is never
 * loaded (it is a lazy chunk). Resolves to whether analytics is on.
 */
export function initAnalytics(key: string | undefined): Promise<boolean> {
  const apiKey = key?.trim();
  if (!apiKey || typeof window === "undefined") return Promise.resolve(false);
  starting ??= import("posthog-js")
    .then(({ default: posthog }) => {
      posthog.init(apiKey, {
        api_host: "/ingest",
        ui_host: "https://us.posthog.com",
        person_profiles: "identified_only",
        capture_pageview: "history_change",
        session_recording: { maskAllInputs: true },
      });
      client = posthog;
      return true;
    })
    .catch(() => false);
  return starting;
}

/** Fire an event. No-op before init; never throws. */
export function track(event: AnalyticsEvent, props?: AnalyticsProps): void {
  if (!client) return;
  try {
    if (event === "run_finished") {
      const id = props?.run_id;
      if (typeof id !== "string" || !id) return;
      if (reportedRuns.has(id) || storedRunReported(id)) return;
      reportedRuns.add(id);
      rememberRunReported(id);
    }
    client.capture(event, props);
  } catch {
    // analytics must never break the app
  }
}

// Reloading the page on a finished run must not report it again, so the ids also live in localStorage.
const REPORTED_KEY = "prospector.analytics.reportedRuns";
const REPORTED_MAX = 50;

function storedRuns(): string[] {
  try {
    const raw = window.localStorage.getItem(REPORTED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function storedRunReported(id: string): boolean {
  return storedRuns().includes(id);
}

function rememberRunReported(id: string): void {
  try {
    window.localStorage.setItem(REPORTED_KEY, JSON.stringify([...storedRuns(), id].slice(-REPORTED_MAX)));
  } catch {
    // storage blocked: the in-memory set still covers this page load
  }
}

export type SellerKind ="url" | "handle" | "sentence";

/** Same cues as classifyInput (src/planner/resolve.ts), which is server-only so it can't be imported here. */
export function sellerKind(raw: string): SellerKind {
  const value = raw.trim();
  if (/^@[\w.]+$/.test(value)) return "handle";
  if (/^https?:\/\//i.test(value) || (!/\s/.test(value) && value.includes("."))) return "url";
  return "sentence";
}

export function sellerSubmittedProps(raw: string): { text: string; kind: SellerKind; length: number } {
  const value = raw.trim();
  return { text: value.slice(0, SELLER_TEXT_CAP), kind: sellerKind(value), length: value.length };
}

/** Test seam: back to the never-initialised state. */
export function resetAnalyticsForTests(): void {
  client = null;
  starting = null;
  reportedRuns.clear();
  try {
    window.localStorage.removeItem(REPORTED_KEY);
  } catch {
    // no window in node tests
  }
}
