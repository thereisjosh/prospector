import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BudgetExceededError, estimateExaCost, type CostGuard } from "../src/exa";
import { estimateContactCost } from "../src/contacts";
import { parseContactCases, parseContactJudge, contactPrompt, maskReply } from "./harness/judge-contacts";
import { BUYER_ROLES, enrichmentUrls, findStateFiles, runContactEval, selectCompanies, summarise } from "./contact-eval";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ce-"));
  const truth = (sc: string, file: string, v: object) => {
    mkdirSync(join(root, "truth", sc), { recursive: true });
    writeFileSync(join(root, "truth", sc, file), JSON.stringify(v));
  };
  truth("S1", "acme__1.json", { company: "Acme Logistics", signal_url: "https://x/1", good: true });
  truth("S1", "acme__1.prev.json", { company: "Acme Logistics", signal_url: "https://x/1", good: true });
  truth("S1", "bad__2.json", { company: "Bad Co", signal_url: "https://x/2", good: false });
  truth("S1", "nourl__3.json", { company: "NoUrl Inc", signal_url: "https://x/3", good: true });
  truth("S2", "acme__4.json", { company: "Acme Logistics", signal_url: "https://x/4", good: true });
  truth("S2", "fund__5.json", { company: "FundCo", signal_url: "https://x/5", good: true });
  mkdirSync(join(root, "results", "a", "S1"), { recursive: true });
  writeFileSync(join(root, "results", "a", "S1", "state.json"), JSON.stringify({ caches: { enrichmentByName: { acmelogistics: { url: "https://acme.example/" }, fundco: { url: "ftp://nope" } } } }));
  mkdirSync(join(root, "rec", "b"), { recursive: true });
  writeFileSync(join(root, "rec", "b", "state.json"), JSON.stringify({ caches: { enrichmentByName: { fundco: { url: "https://fund.example/" } } } }));
  return root;
}

describe("contact-eval company set", () => {
  it("takes distinct GOOD companies, looks the URL up in recorded enrichment, skips those with none", () => {
    const root = fixture();
    const files = findStateFiles([join(root, "results"), join(root, "rec")]);
    expect(files).toHaveLength(2);
    expect(enrichmentUrls(files).get("fundco")).toBe("https://fund.example/"); // non-http url ignored, next file wins
    const { companies, skipped } = selectCompanies({ truthRoot: join(root, "truth"), stateFiles: files });
    expect(companies.map((c) => [c.company, c.scenarioId, c.companyUrl])).toEqual([
      ["Acme Logistics", "S1", "https://acme.example/"],
      ["FundCo", "S2", "https://fund.example/"],
    ]);
    expect(skipped).toEqual([{ company: "NoUrl Inc", scenarioId: "S1", reason: "no company URL" }]);
  });
  it("caps and lists the overflow", () => {
    const root = fixture();
    const { companies, skipped } = selectCompanies({ truthRoot: join(root, "truth"), stateFiles: findStateFiles([join(root, "results"), join(root, "rec")]), cap: 1 });
    expect(companies).toHaveLength(1);
    expect(skipped.map((s) => s.reason)).toContain("over cap");
  });
});

describe("contact-eval run", () => {
  const company = (name: string, scenarioId: "S1" | "S2" = "S1") => ({ company: name, scenarioId, signalUrl: "https://sig/", companyUrl: "https://c.example/" });
  const person = (title: string) => ({
    results: [{ url: "https://www.linkedin.com/in/jane-doe", title: "Jane Doe", entities: [{ type: "person", properties: { name: "Jane Doe", workHistory: [{ title, company: "A", dates: { from: "2020-01", to: null } }] } }] }],
    costDollars: { total: 0.01 },
  });
  // A fake that charges the guard like the real exaSearch does.
  const charging = (perCall: number, title = "VP of Operations") => async (body: Record<string, unknown>, _c: unknown, guard?: CostGuard) => {
    const est = estimateExaCost(body);
    guard?.reserve(est);
    guard?.settle(est, perCall);
    return body.category === "people" ? person(title) : { results: [], costDollars: { total: perCall } };
  };

  it("stops cleanly when the guard refuses, writes jsonl shapes and unlabelled cases", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-run-"));
    const one = estimateContactCost("A", [...BUYER_ROLES.S1]);
    const { rows, summary } = await runContactEval({
      set: "t",
      companies: [company("A"), company("B"), company("C", "S2")],
      skipped: [{ company: "Z", scenarioId: "S1", reason: "no company URL" }],
      maxExaDollars: one * 1.5, // room for one company only
      resultsDir: join(dir, "res"),
      casesFile: join(dir, "cases.jsonl"),
      deps: { exaSearch: charging(0.01) as never },
    });
    expect(rows.map((r) => r.company)).toEqual(["A"]);
    expect(summary.stoppedByGuard).toBe(true);
    expect(summary.companiesRun).toBe(1);
    expect(summary.exaDollars).toBeCloseTo(0.02, 5);

    const line = JSON.parse(readFileSync(join(dir, "res", "contacts.jsonl"), "utf8").trim()) as Record<string, unknown>;
    expect(Object.keys(line).sort()).toEqual(["company", "contacts", "cost", "latencyMs", "roles", "scenarioId"]);
    expect(line.roles).toEqual(BUYER_ROLES.S1);

    const cases = parseContactCases(readFileSync(join(dir, "cases.jsonl"), "utf8")); // validates the schema
    for (const c of cases) expect(c.label).toBeNull();
    expect(cases.every((c) => c.company === "A")).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "res", "summary.json"), "utf8")).skipped).toHaveLength(1);
  });

  it("uses S2 funded-B2B roles and does not duplicate cases on a rerun", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-run2-"));
    const args = { set: "t", companies: [company("A", "S2")], skipped: [], maxExaDollars: 1, resultsDir: join(dir, "res"), casesFile: join(dir, "cases.jsonl"), deps: { exaSearch: charging(0.01, "Head of Sales") as never } };
    const first = await runContactEval(args);
    expect(first.rows[0]!.contacts.length).toBeGreaterThan(0);
    expect(first.rows[0]!.roles).toEqual(BUYER_ROLES.S2);
    await runContactEval(args);
    const lines = readFileSync(join(dir, "cases.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(first.rows[0]!.contacts.length);
  });

  it("summarise: counts and p50", () => {
    const row = (cost: number, ms: number, tiers: Array<"verified" | "inferred">) => ({ company: "x", scenarioId: "S1" as const, roles: [], contacts: tiers.map((tier) => ({ name: "n", tier, role: "r", why: "w" })), cost, latencyMs: ms });
    const s = summarise("t", [row(0.02, 30, ["verified", "inferred"]), row(0.01, 10, ["verified"]), row(0.03, 20, [])], 2, false);
    expect(s).toMatchObject({ companiesRun: 3, contacts: 3, verified: 2, inferred: 1, p50LatencyMs: 20, costPerCompany: 0.02 });
  });
});

describe("judge-contacts", () => {
  it("parses the LAST json block of a reply with prose first", () => {
    const reply = `Yes, on the team page. An earlier draft said {"current": "no", "source": "", "note": "draft"}.\n\nFinal:\n{"current": "yes", "source": "https://a.example/team", "note": "listed as COO"}`;
    expect(parseContactJudge(reply)).toEqual({ current: "yes", source: "https://a.example/team", note: "listed as COO" });
    expect(parseContactJudge("no json here")).toBeUndefined();
  });
  it("asks the question in the prompt without the tier, and masks emails/keys", () => {
    const p = contactPrompt({ id: "a#0", company: "Acme", name: "Jane Doe", title: "COO", tier: "verified" });
    expect(p).toContain("Is Jane Doe currently COO at Acme?");
    expect(p).not.toContain("verified");
    expect(maskReply("mail jane@acme.com key sk-ant-abcdefghijklmnopqrstuv")).toBe("mail [email] key [key]");
  });
});
