import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agreementWithOpus, judgeContactsWithJev, normalizeUrl, pageTextIndex, verifiedContactCases } from "./harness/judge-contacts";
import { estimateJevDollars, fakeJevFetch, jevVerdict, mismatchLines, parseJudgeModel, reportItems } from "./online/calibrate-judge";
import { judgePayload } from "../src/agent/judge-input";
import { JEV_DEFAULT_MODEL, JevApiError, JevConfigError, JevResponseError, contactAnswerFromNoul, jevAsk, jevContactCurrent, jevCostDollars, jevLeadJudge, leadChoiceQuestion } from "../src/judges/jev";

type Call = { url: string; init: { method: string; headers: Record<string, string>; body: string } };

function fakeFetch(respond: (body: { state: unknown; model: string; questions: Record<string, { type: string }> }, n: number) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const f = (async (url: string, init: Call["init"]) => {
    calls.push({ url, init });
    const { status = 200, json } = respond(JSON.parse(init.body), calls.length);
    return new Response(typeof json === "string" ? json : JSON.stringify(json), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const choice = (c: string, conf = 0.9) => ({ type: "choice", choice: c, probabilities: { yes: c === "yes" ? 0.9 : 0.05, no: c === "no" ? 0.9 : 0.05, cannot_verify: c === "cannot_verify" ? 0.9 : 0.05 }, confidence: conf });

const payload = judgePayload({
  company: "Acme Logistics",
  signal_url: "https://acme.example/news",
  why_now: "Opened a new warehouse",
  event_date: "2026-09-01",
  size_basis: "quoted",
  contract: { who: ["3PL?"], size_band: "50–500 employees", hq_countries: ["US"], recency_months: 6, window: "2026-04-01..2026-10-01" },
});

const noKey = { apiKey: undefined as string | undefined };

describe("jevAsk request and response", () => {
  it("posts the documented shape: /v1/systemone, bearer auth, state + model + questions", async () => {
    const { f, calls } = fakeFetch(() => ({ json: { model: "jev-1.13.0", answers: { u: { type: "noul", noul: 0.7 } }, usage: { input_tokens: 1000, output_tokens: 0 } } }));
    const r = await jevAsk({ a: 1 }, { u: { type: "noul", instructions: "Is it?" } }, { apiKey: " k-123 ", baseUrl: "https://jev.example/", fetch: f });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://jev.example/v1/systemone");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toEqual({ Authorization: "Bearer k-123", "Content-Type": "application/json" });
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ state: { a: 1 }, model: JEV_DEFAULT_MODEL, questions: { u: { type: "noul", instructions: "Is it?" } } });
    expect(r.answers.u).toEqual({ type: "noul", noul: 0.7 });
    expect(r.costDollars).toBeCloseTo(1000 * 42e-9, 12);
  });

  it("defaults the base URL and reads JEV_BASE_URL", async () => {
    const ok = () => ({ json: { model: "m", answers: { u: { type: "noul", noul: 0.1 } }, usage: { input_tokens: 1, output_tokens: 0 } } });
    const a = fakeFetch(ok);
    await jevAsk("s", { u: { type: "noul", instructions: "?" } }, { apiKey: "k", fetch: a.f });
    expect(a.calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    process.env.JEV_BASE_URL = "https://proxy.example";
    try {
      const b = fakeFetch(ok);
      await jevAsk("s", { u: { type: "noul", instructions: "?" } }, { apiKey: "k", fetch: b.f });
      expect(b.calls[0]!.url).toBe("https://proxy.example/v1/systemone");
    } finally {
      delete process.env.JEV_BASE_URL;
    }
  });

  it("parses choice and score answers", async () => {
    const { f } = fakeFetch(() => ({
      json: {
        model: "m",
        answers: { c: choice("no"), s: { type: "score", score: 1.43, legend: { "0": "low", "1": "mid", "2": "high" }, probabilities: { "0": 0, "1": 0.57, "2": 0.43 }, confidence: 0.35 } },
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    }));
    const r = await jevAsk("s", { c: { type: "choice", instructions: "?", criteria: { yes: null, no: null, cannot_verify: null } }, s: { type: "score", instructions: "?", criteria: ["a", "b", "c"] } }, { apiKey: "k", fetch: f });
    expect(r.answers.c).toMatchObject({ type: "choice", choice: "no", confidence: 0.9 });
    expect(r.answers.s).toMatchObject({ type: "score", score: 1.43 });
  });

  it("rejects a malformed answer instead of guessing", async () => {
    const wrongType = fakeFetch(() => ({ json: { model: "m", answers: { u: { type: "choice", choice: "yes", probabilities: { yes: 1 }, confidence: 1 } }, usage: { input_tokens: 1, output_tokens: 0 } } }));
    await expect(jevAsk("s", { u: { type: "noul", instructions: "?" } }, { apiKey: "k", fetch: wrongType.f })).rejects.toBeInstanceOf(JevResponseError);
    const missing = fakeFetch(() => ({ json: { model: "m", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } } }));
    await expect(jevAsk("s", { u: { type: "noul", instructions: "?" } }, { apiKey: "k", fetch: missing.f })).rejects.toThrow(/no answer for question "u"/);
    const notJson = fakeFetch(() => ({ json: "<html>" }));
    await expect(jevAsk("s", { u: { type: "noul", instructions: "?" } }, { apiKey: "k", fetch: notJson.f })).rejects.toBeInstanceOf(JevResponseError);
  });

  it("surfaces HTTP errors without the key, retries 429 then succeeds, gives up after maxRetries", async () => {
    const q = { u: { type: "noul" as const, instructions: "?" } };
    const bad = fakeFetch(() => ({ status: 401, json: { error: "bad key secret-key" } }));
    const err = await jevAsk("s", q, { apiKey: "secret-key", fetch: bad.f }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JevApiError);
    expect((err as JevApiError).status).toBe(401);
    expect((err as Error).message).not.toContain("secret-key");
    const flaky = fakeFetch((_b, n) => (n < 3 ? { status: 429, json: {} } : { json: { model: "m", answers: { u: { type: "noul", noul: 1 } }, usage: { input_tokens: 1, output_tokens: 0 } } }));
    const slept: number[] = [];
    await jevAsk("s", q, { apiKey: "k", fetch: flaky.f, sleep: async (ms) => void slept.push(ms) });
    expect(flaky.calls).toHaveLength(3);
    expect(slept).toEqual([500, 1000]);
    const down = fakeFetch(() => ({ status: 529, json: {} }));
    await expect(jevAsk("s", q, { apiKey: "k", fetch: down.f, maxRetries: 1, sleep: async () => {} })).rejects.toMatchObject({ status: 529 });
    expect(down.calls).toHaveLength(2);
  });
});

describe("missing key", () => {
  it("is a clear error and makes no request, for every entry point", async () => {
    const saved = process.env.JEV_API_KEY;
    delete process.env.JEV_API_KEY;
    try {
      const { f, calls } = fakeFetch(() => ({ json: {} }));
      await expect(jevAsk("s", { u: { type: "noul", instructions: "?" } }, { fetch: f })).rejects.toBeInstanceOf(JevConfigError);
      await expect(jevAsk("s", { u: { type: "noul", instructions: "?" } }, { fetch: f, ...noKey, apiKey: "  " })).rejects.toThrow(/JEV_API_KEY is not set/);
      await expect(jevLeadJudge(payload, { fetch: f })).rejects.toThrow(/never falls back/);
      await expect(jevContactCurrent("t", "A", "B", "C", { fetch: f })).rejects.toBeInstanceOf(JevConfigError);
      await expect(jevVerdict("judge_q1", payload, { fetch: f })).rejects.toBeInstanceOf(JevConfigError);
      expect(calls).toHaveLength(0);
    } finally {
      if (saved !== undefined) process.env.JEV_API_KEY = saved;
    }
  });
});

describe("jevLeadJudge", () => {
  it("sends the payload as state and three Choice questions with the rubric vocabulary and rules", async () => {
    const { f, calls } = fakeFetch((b) => ({ json: { model: "jev-1.13.0", answers: Object.fromEntries(Object.keys(b.questions).map((id, i) => [id, choice(["yes", "no", "cannot_verify"][i]!, [0.8, 0.7, 0.6][i])])), usage: { input_tokens: 2500, output_tokens: 0 } } }));
    const v = await jevLeadJudge(payload, { apiKey: "k", fetch: f });
    const body = JSON.parse(calls[0]!.init.body) as { state: unknown; questions: Record<string, { type: string; instructions: { task: string; rules: string }; criteria: Record<string, string> }> };
    expect(calls).toHaveLength(1);
    expect(body.state).toEqual(JSON.parse(JSON.stringify(payload)));
    expect(Object.keys(body.questions)).toEqual(["q1", "q2", "q3"]);
    for (const q of Object.values(body.questions)) {
      expect(q.type).toBe("choice");
      expect(Object.keys(q.criteria)).toEqual(["yes", "no", "cannot_verify"]);
    }
    expect(body.questions.q1!.instructions.rules).toContain("Q1 rules:");
    expect(body.questions.q2!.instructions.rules).toContain("Q2 rules:");
    expect(body.questions.q3!.instructions.rules).toContain("Q3 rules:");
    expect(body.questions.q3!.instructions.task).toContain("Q3 Signal");
    expect(v).toMatchObject({ q1: "yes", q2: "no", q3: "cannot_verify", model: "jev-1.13.0", inputTokens: 2500 });
    expect(v.confidence).toEqual({ q1: 0.8, q2: 0.7, q3: 0.6 });
    expect(v.probabilities.q2).toEqual({ yes: 0.05, no: 0.9, cannot_verify: 0.05 });
    expect(v.costDollars).toBeCloseTo(2500 * 42e-9, 12);
    expect(v.costDollars).toBeCloseTo(0.000105, 9);
  });

  it("`only` asks (and bills) one question; an option outside yes/no/cannot_verify is an error", async () => {
    const one = fakeFetch((b) => ({ json: { model: "m", answers: { q3: choice("yes") }, usage: { input_tokens: 1, output_tokens: 0 } }, _q: Object.keys(b.questions) }));
    const v = await jevLeadJudge(payload, { apiKey: "k", fetch: one.f, only: ["q3"] });
    expect(Object.keys(JSON.parse(one.calls[0]!.init.body).questions)).toEqual(["q3"]);
    expect(v).toMatchObject({ q1: null, q2: null, q3: "yes" });
    const odd = fakeFetch(() => ({ json: { model: "m", answers: { q1: { type: "choice", choice: "maybe", probabilities: { maybe: 1 }, confidence: 1 } }, usage: { input_tokens: 1, output_tokens: 0 } } }));
    await expect(jevLeadJudge(payload, { apiKey: "k", fetch: odd.f, only: ["q1"] })).rejects.toThrow(/not one of yes/);
  });

  it("leadChoiceQuestion uses the same rules text as the Langfuse evaluators", () => {
    expect(JSON.stringify(leadChoiceQuestion("q2"))).toContain("Q2 rules:");
  });
});

describe("jevContactCurrent", () => {
  it("is a Noul over the page text plus the candidate", async () => {
    const { f, calls } = fakeFetch(() => ({ json: { model: "m", answers: { current: { type: "noul", noul: 0.93 } }, usage: { input_tokens: 4000, output_tokens: 0 } } }));
    const v = await jevContactCurrent("Jane Doe, COO", "Jane Doe", "COO", "Acme", { apiKey: "k", fetch: f, pageUrl: "https://acme.example/team", pageDate: "2026-08-01" });
    const body = JSON.parse(calls[0]!.init.body);
    expect(body.state).toEqual({ page: { url: "https://acme.example/team", published: "2026-08-01", text: "Jane Doe, COO" }, candidate: { name: "Jane Doe", title: "COO", company: "Acme" } });
    expect(body.questions.current.type).toBe("noul");
    expect(body.questions.current.instructions).toContain("Jane Doe");
    expect(body.questions.current.criteria).toHaveProperty("true");
    expect(body.questions.current.criteria).toHaveProperty("false");
    expect(v.pFound).toBe(0.93);
    expect(v.costDollars).toBeCloseTo(jevCostDollars(4000), 12);
  });
  it("maps a noul to yes / no / cannot_verify with the documented example thresholds", () => {
    expect([0.95, 0.8, 0.5, 0.2, 0.05].map(contactAnswerFromNoul)).toEqual(["yes", "yes", "cannot_verify", "no", "no"]);
  });
});

describe("calibrate-judge --model jev", () => {
  it("--model parsing", () => {
    expect(parseJudgeModel(undefined)).toBe("anthropic");
    expect(parseJudgeModel("jev")).toBe("jev");
    expect(() => parseJudgeModel("gpt")).toThrow(/anthropic or jev/);
  });

  it("dry run: fake answers flow through the same verdict -> report -> mismatch table as the Anthropic path", async () => {
    const items = [
      { id: "i1", input: payload, expectedOutput: "yes" },
      { id: "i2", input: { ...payload, company: "Beta Co" }, expectedOutput: "no" },
    ];
    const fake = fakeJevFetch();
    const results = [];
    for (const item of items) results.push({ item, output: await jevVerdict("judge_q1", item.input, { apiKey: "dry-run", fetch: fake }), traceId: `t-${item.id}` });
    expect(results[0]!.output.reasoning).toMatch(/^jev jev-1\.13\.0: yes 0\.90, no 0\.05, cannot_verify 0\.05; confidence 0\.80$/);
    const report = reportItems(items, results, []);
    expect(report.map((r) => [r.company, r.expected, r.actual, r.correct])).toEqual([
      ["Acme Logistics", "yes", "yes", true],
      ["Beta Co", "no", "yes", false],
    ]);
    expect(report.every((r) => r.costDollars > 0)).toBe(true);
    const lines = mismatchLines(report);
    expect(lines[0]).toBe("| Dataset input | Expected output | Actual output |");
    expect(lines.join("\n")).toContain("Beta Co");
    expect(lines.join("\n")).toContain("confidence 0.80");
  });

  it("estimate is the documented price times estimated input tokens, and output is free", () => {
    const e = estimateJevDollars("judge_q3", payload);
    expect(e.dollars).toBeCloseTo(e.inputTokens * 42e-9, 12);
    expect(e.dollars).toBeLessThan(0.001);
  });
});

describe("judge-contacts --model jev (evidence-only)", () => {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "jev-contacts-"));
    mkdirSync(join(root, "rec", "set"), { recursive: true });
    const page = (url: string, text: string) => ({ request: { contents: {} }, response: { results: [{ url, text, publishedDate: "2026-05-01T00:00:00.000Z" }, { url: "https://x.example/notext" }] } });
    writeFileSync(join(root, "rec", "set", "a.json"), JSON.stringify(page("https://Acme.example/team/", "Jane Doe Chief Operating Officer")));
    writeFileSync(join(root, "rec", "set", "b.json"), JSON.stringify(page("https://other.example/p", "Bob Roe VP Sales")));
    const contacts = [
      { company: "Acme", contacts: [
        { name: "Jane Doe", tier: "verified", why: "COO", evidence: { url: "https://acme.example/team", title_quote: "Chief Operating Officer" } },
        { name: "Zed", tier: "verified", why: "CEO", evidence: { url: "https://gone.example/", title_quote: "CEO" } },
        { name: "Inf", tier: "inferred", role: "VP", why: "VP" },
      ] },
      { company: "Other", contacts: [{ name: "Bob Roe", tier: "verified", why: "VP Sales", evidence: { url: "https://other.example/p" } }] },
    ].map((r) => JSON.stringify(r)).join("\n");
    return { root, contacts };
  }

  it("joins verified contacts to recorded page text; reports the rest as skipped, never judges them", () => {
    const { root, contacts } = fixture();
    const pages = pageTextIndex(join(root, "rec"));
    expect(normalizeUrl("https://Acme.example/team/#x")).toBe("https://acme.example/team");
    const { cases, missing } = verifiedContactCases(contacts, pages);
    expect(cases.map((c) => [c.name, c.title, c.pageText, c.published])).toEqual([
      ["Jane Doe", "Chief Operating Officer", "Jane Doe Chief Operating Officer", "2026-05-01T00:00:00.000Z"],
      ["Bob Roe", "VP Sales", "Bob Roe VP Sales", "2026-05-01T00:00:00.000Z"],
    ]);
    expect(missing).toEqual([{ company: "Acme", name: "Zed", reason: "no recorded page text for https://gone.example/" }]);
  });

  it("judges each case with a Noul and computes agreement with Opus where both exist", async () => {
    const { root, contacts } = fixture();
    const { cases } = verifiedContactCases(contacts, pageTextIndex(join(root, "rec")));
    const answers = [0.95, 0.1];
    const { f, calls } = fakeFetch((_b, n) => ({ json: { model: "m", answers: { current: { type: "noul", noul: answers[n - 1] } }, usage: { input_tokens: 3000, output_tokens: 0 } } }));
    const rows = await judgeContactsWithJev(cases, { apiKey: "k", fetch: f });
    expect(calls).toHaveLength(2);
    expect(rows.map((r) => r.current)).toEqual(["yes", "no"]);
    expect(rows.reduce((n, r) => n + r.costDollars, 0)).toBeCloseTo(2 * 3000 * 42e-9, 12);
    const a = agreementWithOpus(rows, [{ company: "acme", name: "JANE DOE", current: "yes" }, { company: "Nobody", name: "Q", current: "no" }]);
    expect(a).toMatchObject({ agree: 1, total: 1 });
  });
});
