import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exaSearch, requestHash, stableStringify } from "../src/exa";
import { runProspecting } from "../src/pipeline";
import { V1_PLAN_1 } from "./fixtures/v1-plans";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "exa-rr-"));
  delete process.env.EXA_RECORD_DIR;
  delete process.env.EXA_REPLAY_DIR;
  process.env.EXA_RETRY_BASE_MS = "1"; // 5xx is retried now; keep the backoff tiny
});
afterEach(() => {
  delete process.env.EXA_RETRY_BASE_MS;
  delete process.env.EXA_RECORD_DIR;
  delete process.env.EXA_REPLAY_DIR;
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

const okFetch = (payload: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));

describe("stable hashing", () => {
  it("ignores key order at every depth", () => {
    const a = { query: "q", contents: { summary: { query: "s", schema: { a: 1, b: [{ y: 1, x: 2 }] } } }, n: 3 };
    const b = { n: 3, contents: { summary: { schema: { b: [{ x: 2, y: 1 }], a: 1 }, query: "s" } }, query: "q" };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(requestHash(a)).toBe(requestHash(b));
    expect(requestHash(a)).not.toBe(requestHash({ ...a, n: 4 }));
    expect(requestHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("record / replay", () => {
  it("records {request, response} under the body hash, then replays with fetch never called", async () => {
    const body = { query: "hello", numResults: 2 };
    const payload = { results: [{ url: "https://a.example" }], costDollars: { total: 0.01 } };

    process.env.EXA_RECORD_DIR = dir;
    const recordFetch = okFetch(payload);
    vi.stubGlobal("fetch", recordFetch);
    await exaSearch(body, { apiKey: "k" });
    expect(recordFetch).toHaveBeenCalledTimes(1);
    expect(readdirSync(dir)).toEqual([`${requestHash(body)}.json`]);
    const saved = JSON.parse(readFileSync(join(dir, `${requestHash(body)}.json`), "utf8"));
    expect(saved).toEqual({ request: body, response: payload });

    delete process.env.EXA_RECORD_DIR;
    process.env.EXA_REPLAY_DIR = dir;
    const replayFetch = vi.fn(async () => {
      throw new Error("network must not be called");
    });
    vi.stubGlobal("fetch", replayFetch);
    // Different key order, no API key supplied: still served from disk.
    const replayed = await exaSearch({ numResults: 2, query: "hello" });
    expect(replayed).toEqual(payload);
    expect(replayFetch).not.toHaveBeenCalled();
  });

  it("throws 'replay miss: <hash>' and never falls through to the network", async () => {
    process.env.EXA_REPLAY_DIR = dir;
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const body = { query: "unrecorded" };
    await expect(exaSearch(body, { apiKey: "k" })).rejects.toThrow(`replay miss: ${requestHash(body)}`);
    expect(f).not.toHaveBeenCalled();
  });

  it("does not record failed responses", async () => {
    process.env.EXA_RECORD_DIR = dir;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    await expect(exaSearch({ query: "x" }, { apiKey: "k" })).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("replays a whole run identically when given the recorded now", async () => {
    const now = new Date("2026-09-24T12:00:00.000Z");
    const sigResult = {
      url: "https://news.example.com/shipco",
      title: "ShipCo opens warehouse",
      publishedDate: "2026-09-01T00:00:00.000Z",
      text: "ShipCo opened a warehouse.",
      summary: JSON.stringify({
        company_name: "ShipCo",
        signal_type: "new_facility",
        signal_summary: "ShipCo opened a new warehouse.",
        signal_date: "2026-09-01",
        signal_quote: "ShipCo opens warehouse",
        signal_date_quote: "",
      }),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: { body: string }) => {
        const b = JSON.parse(init.body) as { category?: string };
        const results = b.category === "company"
          ? [{ url: "https://shipco.com", text: "3PL. 300 employees. Ohio, US.", summary: JSON.stringify({ description: "3PL", employee_estimate: 300, employee_estimate_source: "300 employees", is_third_party_logistics: true, is_third_party_logistics_quote: "3PL", is_public_or_enterprise: false, hq: "Ohio, US", hq_quote: "Ohio, US" }) }]
          : [sigResult];
        return new Response(JSON.stringify({ results, costDollars: { total: 0.01 } }), { status: 200 });
      }),
    );
    const opts = { type: "neural" as const, numResults: 5, now, credentials: { apiKey: "k" } };

    process.env.EXA_RECORD_DIR = dir;
    const recorded = await runProspecting(V1_PLAN_1, opts);
    expect(recorded.rows.map((r) => r.company)).toEqual(["ShipCo"]);

    delete process.env.EXA_RECORD_DIR;
    process.env.EXA_REPLAY_DIR = dir;
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const replayed = await runProspecting(V1_PLAN_1, { type: "neural", numResults: 5, now });
    expect(f).not.toHaveBeenCalled();
    expect(replayed.rows).toEqual(recorded.rows);
    expect(replayed.funnel).toEqual(recorded.funnel);
    expect(replayed.totalCostDollars).toBeCloseTo(recorded.totalCostDollars, 9);

    // A different `now` changes startPublishedDate -> different hashes -> miss.
    await expect(
      runProspecting(V1_PLAN_1, { type: "neural", numResults: 5, now: new Date("2026-10-30T00:00:00Z") }),
    ).rejects.toThrow(/replay miss/);
  });
});
