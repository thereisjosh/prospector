import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExaHttpError, exaSearch, retryAfterMs } from "../src/exa";

beforeEach(() => {
  process.env.EXA_RETRY_BASE_MS = "1";
  delete process.env.EXA_MAX_CONCURRENCY;
  delete process.env.EXA_RECORD_DIR;
  delete process.env.EXA_REPLAY_DIR;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.EXA_RETRY_BASE_MS;
});

const ok = () => new Response(JSON.stringify({ results: [], costDollars: { total: 0.001 } }), { status: 200 });
const limited = (headers: Record<string, string> = {}) => new Response('{"error":"rate limit"}', { status: 429, headers });

describe("exaSearch concurrency + retry", () => {
  it("30 concurrent calls never exceed 4 in flight (429 above that) and all succeed", async () => {
    let inFlight = 0;
    let max = 0;
    let rejected = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      const over = inFlight > 4;
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      if (over) {
        rejected += 1;
        return limited();
      }
      return ok();
    }));
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => exaSearch({ query: `q${i}` }, { apiKey: "k" })));
    expect(results).toHaveLength(30);
    expect(max).toBeLessThanOrEqual(4);
    expect(rejected).toBe(0);
  });

  it("EXA_MAX_CONCURRENCY lowers the limit", async () => {
    process.env.EXA_MAX_CONCURRENCY = "2";
    let inFlight = 0;
    let max = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return ok();
    }));
    await Promise.all(Array.from({ length: 10 }, (_, i) => exaSearch({ query: `q${i}` }, { apiKey: "k" })));
    expect(max).toBeLessThanOrEqual(2);
  });

  it("five 429s then a 200 succeeds", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(limited()).mockResolvedValueOnce(limited()).mockResolvedValueOnce(limited())
      .mockResolvedValueOnce(limited()).mockResolvedValueOnce(limited())
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", f);
    await expect(exaSearch({ query: "q" }, { apiKey: "k" })).resolves.toMatchObject({ results: [] });
    expect(f).toHaveBeenCalledTimes(6);
  });

  it("six 429s throw ExaHttpError(429); 5xx is retried, 4xx is not", async () => {
    const f = vi.fn(async () => limited());
    vi.stubGlobal("fetch", f);
    const err = await exaSearch({ query: "q" }, { apiKey: "k" }).catch((e) => e);
    expect(err).toBeInstanceOf(ExaHttpError);
    expect(err.status).toBe(429);
    expect(f).toHaveBeenCalledTimes(6);

    const f5 = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 503 })).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", f5);
    await expect(exaSearch({ query: "q" }, { apiKey: "k" })).resolves.toBeTruthy();
    expect(f5).toHaveBeenCalledTimes(2);

    const f4 = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", f4);
    await expect(exaSearch({ query: "q" }, { apiKey: "k" })).rejects.toMatchObject({ status: 401 });
    expect(f4).toHaveBeenCalledTimes(1);
  });

  it("honours retry-after (seconds or ms), capped at 10s", async () => {
    expect(retryAfterMs("2")).toBe(2000);
    expect(retryAfterMs("250ms")).toBe(250);
    expect(retryAfterMs("1500")).toBe(1500);
    expect(retryAfterMs("120")).toBe(120); // > 60 reads as milliseconds
    expect(retryAfterMs("120000")).toBe(10_000);
    expect(retryAfterMs("45")).toBe(10_000); // 45 s capped
    expect(retryAfterMs("soon")).toBeUndefined();
    expect(retryAfterMs(null)).toBeUndefined();
    const f = vi.fn().mockResolvedValueOnce(limited({ "retry-after": "20ms" })).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", f);
    const t = Date.now();
    await exaSearch({ query: "q" }, { apiKey: "k" });
    expect(Date.now() - t).toBeGreaterThanOrEqual(18);
  });
});
