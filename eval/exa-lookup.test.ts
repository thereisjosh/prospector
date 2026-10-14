import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateExaCost, lookupCompany, LOOKUP_TEXT_MAX } from "../src/exa";
import { EXCERPT_MAX } from "../src/evidence";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.EXA_RECORD_DIR;
  delete process.env.EXA_REPLAY_DIR;
});

function stubFetch(text: string | undefined) {
  const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) =>
    new Response(JSON.stringify({ results: [{ url: "https://acme.com", title: "Acme", summary: JSON.stringify({ description: "Acme" }), ...(text === undefined ? {} : { text }) }], costDollars: { total: 0.011 } }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("lookupCompany page text", () => {
  it("requests the wide text window and keeps the excerpt bounded", async () => {
    const f = stubFetch("word ".repeat(2000));
    const out = await lookupCompany("Acme", "q", {}, { apiKey: "test" });
    const body = JSON.parse(String((f.mock.calls[0]![1] as RequestInit).body));
    expect(body.contents.text).toEqual({ maxCharacters: LOOKUP_TEXT_MAX });
    expect(LOOKUP_TEXT_MAX).toBe(20000);
    expect(out.summary.source_excerpt!.length).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(out.summary.lookup_text_truncated).toBe(false);
  });

  it("flags truncation only when the text hits maxCharacters", async () => {
    stubFetch("x".repeat(LOOKUP_TEXT_MAX));
    expect((await lookupCompany("Acme", "q", {}, { apiKey: "test" })).summary.lookup_text_truncated).toBe(true);
    stubFetch("x".repeat(LOOKUP_TEXT_MAX - 1));
    expect((await lookupCompany("Acme", "q", {}, { apiKey: "test" })).summary.lookup_text_truncated).toBe(false);
  });

  it("sets neither field when Exa returns no text", async () => {
    stubFetch(undefined);
    const { summary } = await lookupCompany("Acme", "q", {}, { apiKey: "test" });
    expect(summary.source_excerpt).toBeUndefined();
    expect(summary.lookup_text_truncated).toBeUndefined();
  });

  it("estimates per-page text cost, independent of maxCharacters", () => {
    const base = { query: "x", category: "company", numResults: 2 };
    const withText = (n: number) => estimateExaCost({ ...base, contents: { summary: {}, text: { maxCharacters: n } } });
    expect(withText(20000)).toBeGreaterThan(estimateExaCost({ ...base, contents: { summary: {} } }));
    expect(withText(20000)).toBe(withText(500));
  });

  it("record/replay still works without an API key", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "exa-lookup-"));
    stubFetch("page text");
    process.env.EXA_RECORD_DIR = dir;
    await lookupCompany("Acme", "q", {}, { apiKey: "test" });
    delete process.env.EXA_RECORD_DIR;
    process.env.EXA_REPLAY_DIR = dir;
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const out = await lookupCompany("Acme", "q", {});
    expect(f).not.toHaveBeenCalled();
    expect(out.summary.lookup_text_truncated).toBe(false);
  });
});
