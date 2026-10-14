/**
 * CI experiment gate (eval/ci/): threshold logic, the approved baseline against the pilot
 * report, the replay runner end to end on a mocked Exa recording, and the workflow file.
 * $0: fetch is stubbed; replay never reaches the network.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDataset, type DatasetItem } from "./datasets";
import type { GradeReport, GraderResult } from "./graders";
import { evaluateGate, gateMarkdown, type ApprovedBaseline, type ScenarioOutcome } from "./ci/gate";
import { BASELINE_FILE, experimentNameFor, readBaseline, runReplay, scenarioOf } from "./ci/experiment-gate";
import { runCell } from "./harness/run-cell";
import { truthKey } from "./harness/truth";

const baseline: ApprovedBaseline = {
  source: "pilot-2026-10-12",
  report: "eval/results/pilot-2026-10-12/report.json",
  arm: "A_workflow",
  maxPrecisionDrop: 0.1,
  scenarios: {
    S1: { precision: 0.35185185185185186, reps: 3, fixture: "fx/S1" },
    S2: { precision: 0.08333333333333333, reps: 3, fixture: "fx/S2" },
  },
};

const ran = (scenarioId: string, precision: number, extra: Partial<Extract<ScenarioOutcome, { status: "ran" }>> = {}): ScenarioOutcome => ({
  scenarioId,
  status: "ran",
  accepted: 10,
  good: Math.round(precision * 10),
  precision,
  unjudged: [],
  ...extra,
});

const grader = (name: GraderResult["name"], pass: boolean, applicable = true): GraderResult => ({ name, pass, applicable, mustPass: true, comment: "" });
const report = (...results: GraderResult[]): GradeReport => ({ pass: results.every((r) => r.pass || !r.mustPass), results, failed: results.filter((r) => !r.pass).map((r) => r.name) });

describe("evaluateGate (threshold logic)", () => {
  it("passes when every scenario ran, is fully judged and stays within 0.1 of its baseline", () => {
    const r = evaluateGate(["S1", "S2"], [ran("S1", 0.3), ran("S2", 0)], baseline);
    expect(r.pass).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.rows.map((x) => x.floor)).toEqual([0.35185185185185186 - 0.1, 0.08333333333333333 - 0.1]);
  });

  it("fails a precision drop of more than 0.1, and only that scenario", () => {
    const r = evaluateGate(["S1", "S2"], [ran("S1", 0.25), ran("S2", 0)], baseline);
    expect(r.pass).toBe(false);
    expect(r.failures).toEqual([expect.objectContaining({ scenarioId: "S1", kind: "precision" })]);
    expect(r.failures[0]!.message).toContain("0.250 < 0.252");
  });

  it("treats a drop of exactly 0.1 as within the threshold", () => {
    const exact: ApprovedBaseline = { ...baseline, scenarios: { S1: { ...baseline.scenarios.S1!, precision: 0.35 } } };
    expect(evaluateGate(["S1"], [ran("S1", 0.25)], exact).pass).toBe(true);
    expect(evaluateGate(["S1"], [ran("S1", 0.2499)], exact).pass).toBe(false);
  });

  it("fails on any applicable must-pass grader failure, even when precision improves", () => {
    const r = evaluateGate(["S1", "S2"], [ran("S1", 0.9, { graders: report(grader("caps_respected", false), grader("tool_order", true)) }), ran("S2", 0.5)], baseline);
    expect(r.failures).toEqual([expect.objectContaining({ scenarioId: "S1", kind: "must_pass", message: "must-pass grader(s) failed: caps_respected" })]);
  });

  it("ignores a grader that does not apply to the run", () => {
    const r = evaluateGate(["S1"], [ran("S1", 0.5, { graders: report(grader("handback_when_short", false, false)) })], { ...baseline, scenarios: { S1: baseline.scenarios.S1! } });
    expect(r.pass).toBe(true);
    expect(r.rows[0]!.gradersApplicable).toBe(0);
  });

  it("fails an unjudged lead as a missing evaluator result instead of scoring it", () => {
    const r = evaluateGate(["S1", "S2"], [ran("S1", 0.9, { unjudged: ["NewCo"] }), ran("S2", 0)], baseline);
    expect(r.failures).toEqual([expect.objectContaining({ scenarioId: "S1", kind: "unjudged" })]);
  });

  it("fails missing fixtures, task errors, missing cases, duplicates and missing baselines", () => {
    const r = evaluateGate(
      ["S1", "S2", "S3"],
      [
        { scenarioId: "S1", status: "missing_fixture", fixture: "fx/S1" },
        { scenarioId: "S2", status: "error", error: "replay miss: abc" },
        { scenarioId: "S2", status: "error", error: "replay miss: abc" },
        ran("S9", 1),
      ],
      baseline,
    );
    const kinds = r.failures.map((f) => `${f.scenarioId}:${f.kind}`).sort();
    expect(kinds).toEqual(["S1:missing_fixture", "S2:duplicate_case", "S2:task_error", "S3:missing_case", "S9:duplicate_case"]);
    expect(r.pass).toBe(false);
  });

  it("renders a summary that names every failure and the uncovered agent arm", () => {
    const r = evaluateGate(["S1"], [ran("S1", 0.1)], baseline);
    const md = gateMarkdown(r, { experiment: "ci-abc", runName: "ci-abc:A_workflow:r1" });
    expect(md).toContain("Experiment gate: FAIL");
    expect(md).toContain("S1 · precision");
    expect(md).toContain("agent arm");
  });
});

describe("approved baseline", () => {
  it("equals the A_workflow means in the pilot's committed report.json (no drift)", () => {
    const file = readBaseline();
    const pilot = JSON.parse(readFileSync(file.report, "utf8")) as { summaries: Array<{ scenarioId: string; arm: string; mean_precision: number; n: number }> };
    for (const [id, s] of Object.entries(file.scenarios)) {
      const summary = pilot.summaries.find((x) => x.scenarioId === id && x.arm === file.arm)!;
      expect(s.precision).toBe(summary.mean_precision);
      expect(s.reps).toBe(summary.n);
    }
    expect(file.source).toBe("pilot-2026-10-12");
    expect(file.maxPrecisionDrop).toBe(0.1);
  });

  it("covers every prospector-scenarios dataset item", () => {
    const ids = readDataset("prospector-scenarios").map((i) => scenarioOf(i).id).sort();
    expect(Object.keys(readBaseline(BASELINE_FILE).scenarios).sort()).toEqual(ids);
  });
});

describe("experimentNameFor", () => {
  it("names the experiment ci-<12 hex>", () => {
    expect(experimentNameFor("F6B2558ABCDEF0123456789")).toBe("ci-f6b2558abcde");
    expect(() => experimentNameFor("main")).toThrow(/not a commit sha/);
  });
});

describe("runReplay (mocked Exa recording)", () => {
  let root: string;
  const now = "2026-09-24T12:00:00.000Z";
  const signalUrl = "https://news.example.com/shipco";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gate-"));
    process.env.EXA_RETRY_BASE_MS = "1";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.EXA_RECORD_DIR;
    delete process.env.EXA_REPLAY_DIR;
    delete process.env.EXA_RETRY_BASE_MS;
    rmSync(root, { recursive: true, force: true });
  });

  const exaFetch = () =>
    vi.fn(async (_u: string, init: { body: string }) => {
      const b = JSON.parse(init.body) as { category?: string };
      const results =
        b.category === "company"
          ? [{ url: "https://shipco.com", title: "ShipCo", text: "third party logistics provider. 300 employees. Ohio, US.", summary: JSON.stringify({ description: "third party logistics provider", employee_estimate: 300, employee_estimate_source: "300 employees", is_third_party_logistics: true, is_third_party_logistics_quote: "third party logistics provider", is_public_or_enterprise: false, hq: "Ohio, US", hq_quote: "Ohio, US" }) }]
          : [
              {
                url: signalUrl,
                title: "ShipCo opens warehouse",
                publishedDate: "2026-09-01T00:00:00.000Z",
                text: "ShipCo opened a warehouse.",
                summary: JSON.stringify({ company_name: "ShipCo", signal_type: "new_facility", signal_summary: "ShipCo opened a new warehouse.", signal_date: "2026-09-01", signal_quote: "ShipCo opens warehouse", signal_date_quote: "" }),
              },
            ];
      return new Response(JSON.stringify({ results, costDollars: { total: 0.01 } }), { status: 200 });
    });

  /** Record the S1 workflow cell against the mocked Exa, as `--record` would, into <root>/fx/S1. */
  async function recordFixture(item: DatasetItem): Promise<string> {
    const fixture = join(root, "fx", "S1");
    mkdirSync(fixture, { recursive: true });
    vi.stubGlobal("fetch", exaFetch());
    process.env.EXA_RECORD_DIR = fixture;
    // Recording hits the (mocked) network, so it needs a key; replay must not. The key is scoped
    // to this call so the runReplay tests prove replay is served with no credential at all.
    const prevKey = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "test-key";
    let record;
    try {
      record = await runCell(scenarioOf(item), "A_workflow", 1, { now: new Date(now), resultsRoot: join(root, "rec"), runSetId: "ci-fixtures" });
    } finally {
      delete process.env.EXA_RECORD_DIR;
      if (prevKey === undefined) delete process.env.EXA_API_KEY;
      else process.env.EXA_API_KEY = prevKey;
    }
    writeFileSync(join(fixture, "cell.json"), JSON.stringify(record));
    expect(record.leads.map((l) => l.company)).toEqual(["ShipCo"]);
    return fixture;
  }

  function writeVerdict(good: boolean) {
    const dir = join(root, "truth", "S1");
    mkdirSync(dir, { recursive: true });
    const a = good ? "yes" : "no";
    writeFileSync(
      join(dir, `${truthKey("ShipCo", signalUrl)}.json`),
      JSON.stringify({ company: "ShipCo", signal_url: signalUrl, scenarioId: "S1", q1: a, q1_source: signalUrl, q2: "yes", q2_source: signalUrl, q3: a, q3_source: signalUrl, good, judgedAt: now, judge: "opus" }),
    );
  }

  it("replays the dataset item from the recording with no network, scores it from eval/truth and gates it", async () => {
    const item = readDataset("prospector-scenarios").find((i) => i.id === "scenario-S1")!;
    const fixture = await recordFixture(item);
    writeVerdict(true);
    const network = vi.fn(async () => {
      throw new Error("network must not be called in replay");
    });
    vi.stubGlobal("fetch", network);
    const b: ApprovedBaseline = { ...baseline, scenarios: { S1: { ...baseline.scenarios.S1!, fixture } } };
    const run = await runReplay({ experiment: "ci-test", items: [item], baseline: b, resultsRoot: join(root, "out"), truthRoot: join(root, "truth") });
    expect(network).not.toHaveBeenCalled();
    expect(run.outcomes).toEqual([{ scenarioId: "S1", status: "ran", accepted: 1, good: 1, precision: 1, unjudged: [] }]);
    expect(run.result.pass).toBe(true);
    expect(run.cells[0]!.record).toMatchObject({ arm: "A_workflow", rep: 1, now });
  });

  it("fails the gate when the replayed lead is judged not good (precision 0 < 0.252)", async () => {
    const item = readDataset("prospector-scenarios").find((i) => i.id === "scenario-S1")!;
    const fixture = await recordFixture(item);
    writeVerdict(false);
    vi.stubGlobal("fetch", vi.fn());
    const b: ApprovedBaseline = { ...baseline, scenarios: { S1: { ...baseline.scenarios.S1!, fixture } } };
    const run = await runReplay({ experiment: "ci-test", items: [item], baseline: b, resultsRoot: join(root, "out"), truthRoot: join(root, "truth") });
    expect(run.result.failures).toEqual([expect.objectContaining({ kind: "precision" })]);
  });

  it("reports an unjudged lead and a replay miss as failures, not passes", async () => {
    const item = readDataset("prospector-scenarios").find((i) => i.id === "scenario-S1")!;
    const fixture = await recordFixture(item);
    vi.stubGlobal("fetch", vi.fn());
    const b: ApprovedBaseline = { ...baseline, scenarios: { S1: { ...baseline.scenarios.S1!, fixture } } };
    const unjudged = await runReplay({ experiment: "ci-test", items: [item], baseline: b, resultsRoot: join(root, "out"), truthRoot: join(root, "truth") });
    expect(unjudged.result.failures).toEqual([expect.objectContaining({ kind: "unjudged" })]);

    // A code change that alters a request (here: the recency window) misses the recording.
    const changed = { ...item, input: { ...(item.input as object), plan: { ...(item.input as { plan: object }).plan, months: 6 } } } as DatasetItem;
    const miss = await runReplay({ experiment: "ci-test", items: [changed], baseline: b, resultsRoot: join(root, "out2"), truthRoot: join(root, "truth") });
    expect(miss.result.failures).toEqual([expect.objectContaining({ kind: "task_error", message: expect.stringMatching(/replay miss/) })]);
  });
});

describe(".github/workflows/experiment-gate.yml", () => {
  const yml = readFileSync(".github/workflows/experiment-gate.yml", "utf8");
  it("runs the prompt diff and the gate on the agent/planner/gates/dataset paths", () => {
    for (const p of ["src/agent/**", "src/planner/**", "src/gates.ts", "eval/datasets/**"]) expect(yml).toContain(`- "${p}"`);
    expect(yml).toContain("npx tsx eval/langfuse-prompts.ts diff");
    expect(yml).toContain("npx tsx eval/ci/experiment-gate.ts --sha");
  });
  it("references secrets by name only and never passes model or Exa keys", () => {
    const secrets = [...yml.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]).sort();
    expect([...new Set(secrets)]).toEqual(["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"]);
    expect(yml).not.toMatch(/ANTHROPIC_API_KEY|EXA_API_KEY/);
  });
});
