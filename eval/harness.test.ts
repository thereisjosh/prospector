import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunState, type RunState } from "../src/agent/state";
import { squashName } from "../src/gates";
import { eventInWindow, truthKey } from "./harness/truth";
import type { SearchPlan } from "../src/plan";
import { createBlindPool } from "./harness/blind";
import { balancedJsonObjects, judgeBlind, judgeLead, parseJudgeJson, userPrompt } from "./harness/judge";
import { CellError as CellErrorLike, normalizeArm, runCell, runMatrix } from "./harness/run-cell";
import { scoreSet } from "./harness/score";
import { applyFirstHandbackSuggestion } from "./harness/sim-user";
import type { Arm, RunRecord, Scenario, Verdict } from "./harness/types";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "harness-test-"));
  roots.push(root);
  return root;
}

const plan: SearchPlan = {
  label: "Harness scenario",
  months: 3,
  signalQueries: ["expansion"],
  signalSummaryQuery: "signal",
  companySummaryQuery: "company",
  gateFields: [{ key: "is_operator", question: "Operator?", required: true }],
  employeeRange: { min: 50, max: 500, unknownPolicy: "allow-if-not-enterprise" },
  hqCountries: ["US"],
  excludeDomains: [],
  excludeNames: [],
  signalTypes: ["expansion"],
};

const scenario: Scenario = {
  id: "S1",
  label: "Harness scenario",
  plan,
  targetLeads: 10,
  maxCostDollars: 1,
};

function record(arm: Arm, rep: number, leads: string[], over: Partial<RunRecord> = {}): RunRecord {
  return {
    scenarioId: "S1",
    arm,
    rep,
    leads: leads.map((company) => ({
      company,
      signal_url: `https://news.example/${squashName(company)}`,
      why_now: "opened a facility",
      event_date: "2026-10-01",
      size_basis: "quoted",
    })),
    spend: { exa: 0.2, claude: arm === "A_workflow" ? 0 : 0.1, total: arm === "A_workflow" ? 0.2 : 0.3 },
    activeMs: 1000,
    stopReason: "target",
    startedAt: "2026-10-12T00:00:00.000Z",
    finishedAt: "2026-10-12T00:00:01.000Z",
    maxCostDollars: 1,
    targetLeads: 10,
    ...over,
  };
}

async function writeTruth(root: string, verdict: Verdict) {
  const dir = join(root, verdict.scenarioId);
  await mkdir(dir, { recursive: true });
  const url = verdict.signal_url ?? `https://news.example/${squashName(verdict.company)}`;
  await writeFile(join(dir, `${truthKey(verdict.company, url)}.json`), `${JSON.stringify({ ...verdict, signal_url: url })}\n`, "utf8");
}

function verdict(company: string, q2: "yes" | "no" | "cannot_verify" = "yes"): Verdict {
  return {
    company,
    scenarioId: "S1",
    q1: "yes",
    q1_source: "https://company.example",
    q2,
    q2_source: "https://size.example",
    q3: "yes",
    q3_source: "https://signal.example",
    good: q2 !== "no",
    judgedAt: "2026-10-12T00:00:00.000Z",
    judge: "human",
  };
}

describe("eval harness", () => {
  it("runCell maps a workflow run to RunRecord", async () => {
    const root = tempRoot();
    const runProspecting = vi.fn(async () => ({
      rows: [{
        company: "GoodCo",
        one_liner: "",
        fit_reason: "quoted",
        why_now_signal: "opened a warehouse",
        signal_strength: "strong",
        signal_source_url: "https://news.example/good",
        signal_date: "2026-10-01",
        confidence_score: 1,
        freshness_score: 1,
        net_new: true,
      }],
      totalCostDollars: 0.12,
      startPublishedDate: "",
      plan,
      funnel: {},
      rejected: [],
      enriched: [],
      enrichmentQueue: [],
    }));
    const out = await runCell(scenario, "A_workflow", 1, { runProspecting: runProspecting as never, resultsRoot: root, runSetId: "set1" });
    expect(out).toMatchObject({ scenarioId: "S1", arm: "A_workflow", rep: 1, spend: { exa: 0.12, claude: 0, total: 0.12 } });
    expect(out.leads[0]).toMatchObject({ company: "GoodCo", signal_url: "https://news.example/good" });
    expect(JSON.parse(await readFile(join(root, "set1/S1/A_workflow/1/run.json"), "utf8")).leads).toHaveLength(1);
  });

  it("runCell maps an agent run to RunRecord", async () => {
    const root = tempRoot();
    const fakeDrive = vi.fn(async (state: RunState) => {
      state.status = "done";
      state.stopReason = "target";
      state.spend = { exa: 0.1, claude: 0.2, total: 0.3 };
      state.counters.activeMs = 222;
      state.adaptive = { queryRewrites: 1, lookupsSkipped: 2, verificationReads: 3 };
      state.leads.push({
        company: "AgentCo",
        signal_url: "https://news.example/agent",
        why_now: "hiring ops",
        summary: { company_name: "AgentCo", signal_type: "expansion", signal_summary: "x", signal_date: "2026-10-01" },
        details: { event_date: "2026-10-01", size_basis: "quoted" },
        turn: 1,
      });
      return state;
    });
    const out = await runCell(scenario, "B_agent_opus", 2, {
      driveRun: fakeDrive as never,
      createClient: () => ({ messages: { create: vi.fn() } }) as never,
      checkLead: vi.fn() as never,
      resultsRoot: root,
      runSetId: "set1",
    });
    expect(out.runId).toBeTruthy();
    expect(out.spend.total).toBe(0.3);
    expect(out.adaptive).toEqual({ queryRewrites: 1, lookupsSkipped: 2, verificationReads: 3 });
    expect(fakeDrive.mock.calls[0]?.[0].workspaceId).toBe("eval-S1-B_agent_opus-2");
    expect(JSON.parse(await readFile(join(root, "set1/S1/B_agent_opus/2/state.json"), "utf8")).leads[0].company).toBe("AgentCo");
  });

  it("blind pooling dedupes and keeps arm mapping out of blind.json", async () => {
    const root = tempRoot();
    const result = await createBlindPool({
      setId: "set1",
      scenarioId: "S1",
      resultsRoot: root,
      seed: "seed",
      records: [
        record("A_workflow", 1, ["Diakon Logistics"]),
        record("B_agent_opus", 1, ["Diakonlogistics", "OtherCo"]),
      ],
    });
    expect(result.blind).toHaveLength(2);
    const blind = await readFile(join(root, "set1/S1/blind.json"), "utf8");
    const mapping = await readFile(join(root, "set1/S1/mapping.json"), "utf8");
    expect(blind).not.toContain("A_workflow");
    expect(mapping).toContain("A_workflow");
  });

  it("judge parses, retries once, falls back, and reuses truth", async () => {
    const root = tempRoot();
    const lead = record("A_workflow", 1, ["GoodCo"]).leads[0]!;
    const client = { messages: { create: vi.fn()
      .mockResolvedValueOnce({ content: [{ type: "text", text: "not json" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: 'prefix {"q1":"yes","q1_source":"https://a","q2":"yes","q2_source":"https://b","q3":"yes","q3_source":"https://c","note":"ok"} suffix' }] }) } };
    const first = await judgeLead({ scenarioId: "S1", lead: { id: "L001", ...lead }, client: client as never, rubricText: "rubric", truthRoot: root });
    expect(first.good).toBe(true);
    expect(client.messages.create).toHaveBeenCalledTimes(2);
    const reused = await judgeLead({ scenarioId: "S1", lead: { id: "L001", ...lead }, client: client as never, rubricText: "rubric", truthRoot: root });
    expect(reused.good).toBe(true);
    expect(client.messages.create).toHaveBeenCalledTimes(2);

    const badClient = { messages: { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "nope" }] }) } };
    const fallback = await judgeLead({ scenarioId: "S1", lead: { id: "L002", ...record("A_workflow", 1, ["BadCo"]).leads[0]! }, client: badClient as never, rubricText: "rubric", truthRoot: root });
    expect(fallback.q1).toBe("cannot_verify");
    expect(badClient.messages.create).toHaveBeenCalledTimes(2);
    // H2: the all-cannot_verify fallback is returned but never cached, so the next call re-judges.
    await judgeLead({ scenarioId: "S1", lead: { id: "L002", ...record("A_workflow", 1, ["BadCo"]).leads[0]! }, client: badClient as never, rubricText: "rubric", truthRoot: root });
    expect(badClient.messages.create).toHaveBeenCalledTimes(4);
  });

  it("score computes pass@1/pass^3, Q2 tolerance, and workflow-shaped", async () => {
    const resultsRoot = tempRoot();
    const truthRoot = tempRoot();
    for (const company of ["A", "B", "C", "D", "E", "F", "G"]) await writeTruth(truthRoot, verdict(company));
    await writeTruth(truthRoot, verdict("U1", "cannot_verify"));
    await writeTruth(truthRoot, verdict("U2", "cannot_verify"));
    const records = [
      record("B_agent_opus", 1, ["A", "B", "C", "D", "E", "U1", "U2"], { adaptive: { queryRewrites: 0, lookupsSkipped: 0, verificationReads: 0 } }),
      record("B_agent_opus", 2, ["A", "B", "C", "D", "E", "F"], { adaptive: { queryRewrites: 1, lookupsSkipped: 0, verificationReads: 0 } }),
      record("B_agent_opus", 3, ["A", "B", "C", "D", "E", "F"], { adaptive: { queryRewrites: 1, lookupsSkipped: 0, verificationReads: 0 } }),
    ];
    const report = await scoreSet({ setId: "set1", resultsRoot, truthRoot, records });
    expect(report.cells[0]).toMatchObject({ good_leads: 6, workflow_shaped: true, pass: true });
    expect(report.summaries[0]).toMatchObject({ pass_at_1: 1, pass_3: 1, n: 3 });
  });

  it("sim-user applies each suggestion type", () => {
    const base = scenario;
    expect(applyFirstHandbackSuggestion(base, record("B_agent_opus", 1, [], { handback: { shortfall: "", top_reasons: [], suggestions: [{ field: "employeeRange", value: { min: 10, max: 900 }, why: "" }] } })).plan.employeeRange).toMatchObject({ min: 10, max: 900 });
    expect(applyFirstHandbackSuggestion(base, record("B_agent_opus", 1, [], { handback: { shortfall: "", top_reasons: [], suggestions: [{ field: "months", value: 6, why: "" }] } })).plan.months).toBe(6);
    expect(applyFirstHandbackSuggestion(base, record("B_agent_opus", 1, [], { handback: { shortfall: "", top_reasons: [], suggestions: [{ field: "hqCountries", value: "any", why: "" }] } })).plan.hqCountries).toEqual([]);
  });

  it("matrix guard stops at --max-total-dollars", async () => {
    const runProspecting = vi.fn(async () => ({
      rows: [],
      totalCostDollars: 0.6,
      startPublishedDate: "",
      plan,
      funnel: {},
      rejected: [],
      enriched: [],
      enrichmentQueue: [],
    }));
    const root = tempRoot();
    const result = await runMatrix({
      setId: "set1",
      scenarios: [{ ...scenario, maxCostDollars: 0.4 }],
      arms: [normalizeArm("A")],
      reps: 3,
      maxTotalDollars: 1,
      deps: { runProspecting: runProspecting as never, resultsRoot: root },
    });
    expect(result.stopped).toBe(true);
    expect(result.records).toHaveLength(2);
    expect(runProspecting).toHaveBeenCalledTimes(2);
  });

  const rowFor = (company: string, fit_reason: string, why = "opened a warehouse") => ({
    company,
    one_liner: "",
    fit_reason,
    why_now_signal: why,
    signal_strength: "strong",
    signal_source_url: `https://news.example/${squashName(company)}`,
    signal_date: "2026-10-01",
    confidence_score: 1,
    freshness_score: 1,
    net_new: true,
  });
  const workflowRun = (rows: unknown[]) => vi.fn(async () => ({ rows, totalCostDollars: 0.1, startPublishedDate: "", plan, funnel: {}, rejected: [], enriched: [], enrichmentQueue: [] }));

  it("H1: arm A leads carry the same normalised fields as agent arms (no fit_reason leak), sliced to targetLeads", async () => {
    const root = tempRoot();
    const long = "x".repeat(500);
    const rows = [
      rowFor("Q1", "required gates passed: is_operator; 650 estimated employees (quoted); HQ Austin.", long),
      rowFor("Q2", "required gates passed: is_operator; employee count 356 unverified by its source; HQ Austin."),
      rowFor("Q3", "required gates passed: is_operator; employee count not exposed by lookup; HQ Austin."),
    ];
    const out = await runCell({ ...scenario, targetLeads: 2, maxCostDollars: 0.7 }, "A_workflow", 1, { runProspecting: workflowRun(rows) as never, resultsRoot: root, runSetId: "h1" });
    expect(out.leads).toHaveLength(2);
    expect(out.leads.map((l) => l.size_basis)).toEqual(["quoted", "unverified"]);
    expect(out.leads[0]!.why_now).toHaveLength(200);
    expect(JSON.stringify(out)).not.toContain("required gates passed");
    expect(out).toMatchObject({ maxCostDollars: 0.7, targetLeads: 2 });
    expect(Object.keys(out.leads[0]!).sort()).toEqual(["company", "event_date", "signal_url", "size_basis", "why_now"]);
  });

  it("H1: agent leads use the same field shape and store maxCostDollars / targetLeads", async () => {
    const root = tempRoot();
    const fakeDrive = vi.fn(async (state: RunState) => {
      state.status = "done";
      state.stopReason = "target";
      state.leads.push({
        company: "AgentCo",
        signal_url: "https://news.example/agent",
        why_now: "y".repeat(400),
        summary: { company_name: "AgentCo", signal_type: "expansion", signal_summary: "x", signal_date: "2026-10-01" },
        details: { event_date: "2026-10-01", size_basis: "unverified" },
        turn: 1,
      });
      return state;
    });
    const out = await runCell({ ...scenario, targetLeads: 3, maxCostDollars: 0.5 }, "C_agent_sonnet", 1, {
      driveRun: fakeDrive as never,
      createClient: () => ({ messages: { create: vi.fn() } }) as never,
      checkLead: vi.fn() as never,
      resultsRoot: root,
      runSetId: "h1",
    });
    expect(out.leads[0]).toEqual({ company: "AgentCo", signal_url: "https://news.example/agent", why_now: "y".repeat(200), event_date: "2026-10-01", size_basis: "unverified" });
    expect(out).toMatchObject({ maxCostDollars: 0.5, targetLeads: 3 });
  });

  it("H2: truth key is (company, signal_url); blind pool keeps two signals for one company", async () => {
    expect(truthKey("Diakon Logistics", "https://a.example/1")).toBe(truthKey("Diakonlogistics", "https://a.example/1"));
    expect(truthKey("Diakon Logistics", "https://a.example/1")).not.toBe(truthKey("Diakon Logistics", "https://a.example/2"));
    expect(truthKey("Diakon Logistics", "https://a.example/1")).toMatch(/^diakonlogistics__[0-9a-f]{10}$/);
    const root = tempRoot();
    const a = record("A_workflow", 1, ["Diakon Logistics"]);
    const b = record("B_agent_opus", 1, ["Diakonlogistics"]);
    b.leads[0]!.signal_url = "https://other.example/different-signal";
    const pool = await createBlindPool({ setId: "set1", scenarioId: "S1", resultsRoot: root, seed: "s", records: [a, b, record("C_agent_sonnet", 1, ["Diakon Logistics"])] });
    expect(pool.blind).toHaveLength(2); // same signal collapses, a different signal does not
    expect(pool.mapping.find((m) => m.signal_url === a.leads[0]!.signal_url)!.sources).toHaveLength(2);
  });

  it("H2: a cached verdict is reused only while the window still contains the event date", async () => {
    const root = tempRoot();
    const lead = { id: "L1", ...record("A_workflow", 1, ["GoodCo"]).leads[0]!, event_date: "2026-08-01" };
    const reply = { content: [{ type: "text", text: '{"q1":"yes","q1_source":"a","q2":"yes","q2_source":"b","q3":"yes","q3_source":"c"}' }] };
    const client = { messages: { create: vi.fn().mockResolvedValue(reply) } };
    const base = { scenarioId: "S1", lead, client: client as never, rubricText: "r", truthRoot: root, months: 3 };
    const first = await judgeLead({ ...base, now: new Date("2026-10-12T00:00:00Z") });
    expect(first.now).toBe("2026-10-12");
    expect(first.signal_url).toBe(lead.signal_url);
    await judgeLead({ ...base, now: new Date("2026-10-20T00:00:00Z") }); // event still in window -> reuse
    expect(client.messages.create).toHaveBeenCalledTimes(1);
    await judgeLead({ ...base, now: new Date("2026-12-20T00:00:00Z") }); // event now outside -> re-judge
    expect(client.messages.create).toHaveBeenCalledTimes(2);
    expect(eventInWindow("2026-07-12", new Date("2026-10-12T00:00:00Z"), 3)).toBe(true);
    expect(eventInWindow("2026-07-11", new Date("2026-10-12T00:00:00Z"), 3)).toBe(false);
  });

  it("H4: rerun cells are tagged rerunOf, the original record is not rewritten, and score computes handback_rerun after judging", async () => {
    const root = tempRoot();
    const truthRoot = tempRoot();
    for (const c of ["A", "B", "C"]) await writeTruth(truthRoot, verdict(c));
    const handback = { shortfall: "2 of 10", top_reasons: [], suggestions: [{ field: "months", value: 6, why: "" }] };
    const fakeDrive = vi.fn(async (state: RunState) => {
      state.status = "done";
      state.stopReason = "finish";
      state.handback = handback;
      for (const c of state.contract.months === 6 ? ["A", "B", "C"] : ["A"]) {
        state.leads.push({ company: c, signal_url: `https://news.example/${squashName(c)}`, why_now: "x", summary: { company_name: c, signal_type: "expansion", signal_summary: "x", signal_date: "2026-10-01" }, details: { event_date: "2026-10-01", size_basis: "quoted" }, turn: 1 });
      }
      return state;
    });
    const result = await runMatrix({
      setId: "h4", scenarios: [{ ...scenario, maxCostDollars: 0.3 }], arms: ["B_agent_opus"], reps: 1, handback: true, maxTotalDollars: 5,
      deps: { driveRun: fakeDrive as never, createClient: () => ({ messages: { create: vi.fn() } }) as never, checkLead: vi.fn() as never, resultsRoot: root },
    });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).not.toHaveProperty("handback_rerun");
    const rerun = JSON.parse(await readFile(join(root, "h4-handback/S1/B_agent_opus/1/run.json"), "utf8")) as RunRecord;
    expect(rerun.rerunOf).toBe("S1/B_agent_opus/1");
    expect(rerun.leads).toHaveLength(3);
    const scored = await scoreSet({ setId: "h4", resultsRoot: root, truthRoot });
    expect(scored.cells[0]!.handback_rerun).toEqual({ good_leads_before: 1, after: 3 });
  });

  it("H4: matrix guard reserves maxCostDollars x2 per cell when handback runs", async () => {
    const runProspecting = workflowRun([]);
    const result = await runMatrix({
      setId: "set1",
      scenarios: [{ ...scenario, maxCostDollars: 0.4 }],
      arms: ["A_workflow"],
      reps: 3,
      handback: true,
      maxTotalDollars: 1,
      deps: { runProspecting: runProspecting as never, resultsRoot: tempRoot() },
    });
    // 0 + 0.8 <= 1 -> run (spend 0.1); 0.1 + 0.8 = 0.9 <= 1 -> run; 0.2 + 0.8 = 1.0 <= 1 -> run
    expect(result.records).toHaveLength(3);
    const tight = await runMatrix({
      setId: "set2",
      scenarios: [{ ...scenario, maxCostDollars: 0.6 }],
      arms: ["A_workflow"],
      reps: 3,
      handback: true,
      maxTotalDollars: 1,
      deps: { runProspecting: runProspecting as never, resultsRoot: tempRoot() },
    });
    expect(tight.stopped).toBe(true);
    expect(tight.records).toHaveLength(0); // 0 + 1.2 > 1: not even the first cell
  });

  it("H5: pass@1 = passes / n, pass^3 only for exactly 3 runs, cap from the record", async () => {
    const resultsRoot = tempRoot();
    const truthRoot = tempRoot();
    for (const c of ["A", "B", "C", "D", "E", "F"]) await writeTruth(truthRoot, verdict(c));
    const six = ["A", "B", "C", "D", "E", "F"];
    const two = await scoreSet({
      setId: "h5a", resultsRoot, truthRoot,
      records: [record("B_agent_opus", 1, six), record("B_agent_opus", 2, ["A"])],
    });
    expect(two.summaries[0]).toMatchObject({ n: 2, pass_at_1: 0.5, pass_3: null });
    const three = await scoreSet({
      setId: "h5b", resultsRoot, truthRoot,
      records: [1, 2, 3].map((rep) => record("B_agent_opus", rep, six)),
    });
    expect(three.summaries[0]).toMatchObject({ n: 3, pass_at_1: 1, pass_3: 1 });
    const overCap = await scoreSet({
      setId: "h5c", resultsRoot, truthRoot,
      records: [record("B_agent_opus", 1, six, { maxCostDollars: 0.25 })], // spend 0.3 > 0.25
    });
    expect(overCap.cells[0]!.pass).toBe(false);
    await expect(
      scoreSet({ setId: "h5d", resultsRoot, truthRoot, records: [{ ...record("B_agent_opus", 1, six), maxCostDollars: undefined as never }] }),
    ).rejects.toThrow(/maxCostDollars/);
  });

  it("matrix continues after a crashed cell, records it as an error with known spend, and reports ok/error", async () => {
    const root = tempRoot();
    const logs: string[] = [];
    let call = 0;
    const cell = vi.fn(async (sc: Scenario, arm: Arm, rep: number) => {
      call += 1;
      if (call === 2) throw new CellErrorLike("Exa HTTP 429", "run-id-2", { exa: 0.05, claude: 0.1, total: 0.15 });
      return record(arm, rep, [], { scenarioId: sc.id, spend: { exa: 0.1, claude: 0, total: 0.1 } });
    });
    const result = await runMatrix({
      setId: "err", scenarios: [scenario], arms: ["A_workflow"], reps: 3, maxTotalDollars: 50,
      cell: cell as never, deps: { resultsRoot: root, log: (l) => logs.push(l) },
    });
    expect(cell).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ ok: 2, errors: 1, stopped: false });
    expect(result.records[1]).toMatchObject({ stopReason: "error", error: "Exa HTTP 429", leads: [], runId: "run-id-2", spend: { total: 0.15 } });
    const written = JSON.parse(await readFile(join(root, "err/S1/A_workflow/2/run.json"), "utf8"));
    expect(written.stopReason).toBe("error");
    expect(result.total).toBeCloseTo(0.35, 6);
    expect(logs).toContain("cells ok/error: 2/1");
    expect(logs.some((l) => l.includes("FAILED: Exa HTTP 429"))).toBe(true);
  });

  it("a crashed agent cell carries the partial spend from the live state", async () => {
    const root = tempRoot();
    const fakeDrive = vi.fn(async (state: RunState) => {
      state.spend = { exa: 0.2, claude: 0.3, total: 0.5 };
      throw new Error("boom");
    });
    const result = await runMatrix({
      setId: "err2", scenarios: [scenario], arms: ["B_agent_opus"], reps: 1,
      deps: { driveRun: fakeDrive as never, createClient: () => ({ messages: { create: vi.fn() } }) as never, checkLead: vi.fn() as never, resultsRoot: root },
    });
    expect(result.errors).toBe(1);
    expect(result.records[0]).toMatchObject({ stopReason: "error", error: "boom", spend: { exa: 0.2, claude: 0.3, total: 0.5 } });
    expect(result.records[0]!.runId).toBeTruthy();
  });

  it("a crashed workflow cell records the spend the pipeline attached to the error", async () => {
    const root = tempRoot();
    const runProspecting = vi.fn(async () => {
      throw Object.assign(new Error("pipeline boom"), { spendDollars: 0.42 });
    });
    const result = await runMatrix({
      setId: "wf-err", scenarios: [scenario], arms: ["A_workflow"], reps: 1,
      deps: { runProspecting: runProspecting as never, resultsRoot: root },
    });
    expect(result.records[0]).toMatchObject({ stopReason: "error", error: "pipeline boom", spend: { exa: 0.42, claude: 0, total: 0.42 } });
    expect(result.total).toBeCloseTo(0.42, 6);
    const none = await runMatrix({
      setId: "wf-err2", scenarios: [scenario], arms: ["A_workflow"], reps: 1,
      deps: { runProspecting: vi.fn(async () => { throw new Error("no spend info"); }) as never, resultsRoot: root },
    });
    expect(none.records[0]!.spend.total).toBe(0);
  });

  describe("judge with web_search responses", () => {
    const answer = '{"q1":"yes","q1_source":"https://a.example","q2":"cannot_verify","q2_source":"","q3":"yes","q3_source":"https://c.example","note":"ok"}';
    const webSearchResponse = (finalText = `Here is my verdict: ${answer}`, over: Record<string, unknown> = {}) => ({
      stop_reason: "end_turn",
      content: [
        { type: "text", text: "Let me check {the site} first." },
        { type: "server_tool_use", id: "srv1", name: "web_search", input: { query: "GoodCo headcount" } },
        { type: "web_search_tool_result", tool_use_id: "srv1", content: [{ type: "web_search_result", url: "https://x.example", title: "t", text: '{"q1":"no"}' }] },
        { type: "text", text: "The results show the company is a 3PL." },
        { type: "server_tool_use", id: "srv2", name: "web_search", input: { query: "GoodCo warehouse" } },
        { type: "web_search_tool_result", tool_use_id: "srv2", content: [] },
        { type: "text", text: finalText },
      ],
      usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      ...over,
    });
    const lead = () => ({ id: "L1", ...record("A_workflow", 1, ["GoodCo"]).leads[0]! });

    it("reads ALL text blocks and takes the LAST valid JSON object (ignoring braces in commentary)", async () => {
      expect(balancedJsonObjects('x {"a":1} y {"b":"}"} z')).toEqual(['{"a":1}', '{"b":"}"}']);
      const parsed = parseJudgeJson('Let me check {the site}.\n{"q1":"no","q1_source":"","q2":"no","q2_source":"","q3":"no","q3_source":""}\nfinal: ' + answer);
      expect(parsed).toMatchObject({ q1: "yes", q2: "cannot_verify", q3: "yes", q3_source: "https://c.example" });
      expect(parseJudgeJson('{"q1":"maybe","q2":"yes","q3":"yes"}')).toBeUndefined();
      expect(parseJudgeJson("no json at all")).toBeUndefined();
      const root = tempRoot();
      const client = { messages: { create: vi.fn().mockResolvedValue(webSearchResponse()) } };
      const v = await judgeLead({ scenarioId: "S1", lead: lead(), client: client as never, rubricText: "rubric", truthRoot: root, setId: "j", resultsRoot: root });
      expect(v).toMatchObject({ q1: "yes", q2: "cannot_verify", q3: "yes", good: true });
      expect(client.messages.create).toHaveBeenCalledTimes(1);
      const call = client.messages.create.mock.calls[0]![0] as { max_tokens: number; system: string; messages: Array<{ content: string }> };
      expect(call.max_tokens).toBe(4000);
      expect(call.system).toBe("rubric");
      expect(call.messages[0]!.content.endsWith('"note": "..."}')).toBe(true);
      expect(call.messages[0]!.content).toContain("Use web_search as needed (max 4), then reply with exactly one JSON object and nothing after it");
      expect(userPrompt(lead())).toContain("GoodCo");
    });

    it("records usage, Opus-priced cost and web-search count on the verdict", async () => {
      const root = tempRoot();
      const client = { messages: { create: vi.fn().mockResolvedValue(webSearchResponse()) } };
      const v = await judgeLead({ scenarioId: "S1", lead: lead(), client: client as never, rubricText: "r", truthRoot: root, setId: "j", resultsRoot: root });
      expect(v.usage).toEqual({ input: 1_000_000, output: 100_000, cache_read: 0, cache_creation: 0 });
      expect(v.webSearches).toBe(2);
      expect(v.costDollars).toBeCloseTo(4 + 2, 6); // $4/M in + $20/M out x 0.1M
    });

    it("parse failure: raw text + stop_reason saved to judge-failures, one stderr line, uncached fallback, cost still counted", async () => {
      const root = tempRoot();
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const client = { messages: { create: vi.fn().mockResolvedValue(webSearchResponse("I could not decide.", { stop_reason: "max_tokens" })) } };
      const l = lead();
      const v = await judgeLead({ scenarioId: "S1", lead: l, client: client as never, rubricText: "r", truthRoot: root, setId: "j", resultsRoot: root });
      expect(v.q1).toBe("cannot_verify");
      expect(v.costDollars).toBeCloseTo(12, 6); // two attempts
      expect(client.messages.create).toHaveBeenCalledTimes(2);
      const raw = await readFile(join(root, "j/S1/judge-failures", `${truthKey(l.company, l.signal_url)}.txt`), "utf8");
      expect(raw).toContain("stop_reason: max_tokens");
      expect(raw).toContain("I could not decide.");
      expect(raw).toContain("Let me check");
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0]![0])).toContain("GoodCo");
      err.mockRestore();
    });

    it("judgeBlind: --limit, running total + judge-cost.json, and an API error does not abort the scenario", async () => {
      const root = tempRoot();
      const truthRoot = tempRoot();
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const names = ["Aco", "Bco", "Cco", "Dco"];
      const leads = names.map((n, i) => ({ id: `L${i}`, ...record("A_workflow", 1, [n]).leads[0]! }));
      await mkdir(join(root, "j/S1"), { recursive: true });
      await writeFile(join(root, "j/S1/blind.json"), JSON.stringify(leads), "utf8");
      const create = vi.fn()
        .mockRejectedValueOnce(new Error("overloaded"))
        .mockResolvedValue(webSearchResponse());
      const limited = await judgeBlind({ setId: "j", scenarioId: "S1", resultsRoot: root, truthRoot, client: { messages: { create } } as never, limit: 3 });
      expect(create).toHaveBeenCalledTimes(3); // only the first 3 leads; lead 1 errored, 2 and 3 judged
      expect(limited).toHaveLength(2);
      const cost = JSON.parse(await readFile(join(root, "j/S1/judge-cost.json"), "utf8"));
      expect(cost.totalDollars).toBeCloseTo(12, 6);
      expect(cost.perLead).toHaveLength(3);
      expect(cost.perLead[0].error).toBe("overloaded");
      expect(String(err.mock.calls[0]![0])).toContain("overloaded");
      expect(log.mock.calls.some((c) => String(c[0]).includes("running total $12.0000"))).toBe(true);
      log.mockRestore();
      err.mockRestore();
    });
  });
});
