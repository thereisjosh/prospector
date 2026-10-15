/**
 * Fakes for `eval/memory-eval.ts --dry-run` and its test: the REAL agent loop (events, recall,
 * memory append at stop) driven by a scripted model, a canned Exa and a canned judge. No network,
 * no spend. The scripted "agent" chooses its script from what it was handed: a run that was
 * recalled seen companies behaves like an informed agent (skips lookups, searches new ground);
 * a run with an empty memory behaves like a fresh one. So a memory that failed to load or recall
 * shows up in the report as a FAIL, not as a pass.
 */
import { randomUUID } from "node:crypto";
import type { LoopDeps } from "../../src/agent/loop";
import type { LeadChecker } from "../../src/agent/gate-port";
import { squashName } from "../../src/gates";
import type { RunState } from "../../src/agent/state";
import { driveRun } from "../run-agent";
import type { RunCellDeps } from "./types";

const msg = (stop_reason: string, content: unknown[]) => ({
  id: randomUUID(), type: "message", role: "assistant", model: "claude-opus-5-5",
  content, stop_reason, stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
const call = (...blocks: unknown[]) => msg("tool_use", blocks);

const slug = (company: string) => squashName(company);
const signalUrl = (company: string) => `https://news.example/${slug(company)}`;

/** query (exact) -> companies it returns. Anything else returns nothing. */
export const FAKE_SEARCHES: Record<string, string[]> = {
  "warehouse expansion new facility": ["GoodCo", "SecondCo"],
  "obscure shipping dock permit filings": [],
  "new distribution center opening": ["GoodCo", "SecondCo", "ThirdCo", "FourthCo"],
};

const freshScript = () => [
  call(use("p", "propose_strategy", { angles: ["expansion news"], first_queries: Object.keys(FAKE_SEARCHES).slice(0, 2), est_cost_dollars: 0.1 })),
  call(use("s1", "search_signals", { query: "warehouse expansion new facility", num_results: 10 })),
  call(use("s2", "search_signals", { query: "obscure shipping dock permit filings", num_results: 10 })),
  call(use("l1", "lookup_company", { name: "GoodCo" }), use("l2", "lookup_company", { name: "SecondCo" })),
  call(
    use("u1", "submit_lead", { company: "GoodCo", signal_url: signalUrl("GoodCo"), why_now: "opened a warehouse" }),
    use("u2", "submit_lead", { company: "SecondCo", signal_url: signalUrl("SecondCo"), why_now: "opened a depot" }),
  ),
  call(use("f1", "finish", { summary: "done" })), // held once: offers `remember`
  call(use("r", "remember", { text: "Facility-opening news surfaced mid-size operators; permit-filing queries returned nothing.", tags: ["expansion", "warehouse"] })),
  call(use("f2", "finish", { summary: "done" })),
];

const informedScript = () => [
  call(use("p", "propose_strategy", { angles: ["new ground"], first_queries: ["new distribution center opening"], est_cost_dollars: 0.1 })),
  call(use("s1", "search_signals", { query: "new distribution center opening", num_results: 10 })),
  call(
    use("l1", "lookup_company", { name: "GoodCo" }),
    use("l2", "lookup_company", { name: "SecondCo" }),
    use("l3", "lookup_company", { name: "ThirdCo" }),
    use("l4", "lookup_company", { name: "FourthCo" }),
  ),
  call(
    use("u1", "submit_lead", { company: "ThirdCo", signal_url: signalUrl("ThirdCo"), why_now: "opened a distribution center" }),
    use("u2", "submit_lead", { company: "FourthCo", signal_url: signalUrl("FourthCo"), why_now: "opened a hub" }),
  ),
  call(use("f1", "finish", { summary: "done" })),
  call(use("r", "remember", { text: "Distribution-center opening queries find companies the earlier warehouse queries missed.", tags: ["expansion", "distribution"] })),
  call(use("f2", "finish", { summary: "done" })),
];

const scriptedClient = (responses: unknown[]) => ({
  messages: { create: async () => {
    const next = responses.shift();
    if (!next) throw new Error("dry-run script exhausted: the loop asked for more turns than the script has");
    return next;
  } },
}) as never;

export const fakeExaSearch = (async (body: { query: string }) => {
  const companies = FAKE_SEARCHES[body.query] ?? [];
  return {
    results: companies.map((company) => ({
      url: signalUrl(company),
      title: `${company} expands`,
      publishedDate: "2026-10-01T00:00:00.000Z",
      text: `${company} expands its network.`,
      summary: JSON.stringify({ company_name: company, signal_type: "expansion", signal_summary: `${company} opened a site.`, signal_date: "2026-10-01" }),
    })),
    costDollars: { total: 0.007 },
  };
}) as never;

export const fakeLookupCompany = (async (name: string) => ({
  result: { url: `https://${slug(name)}.example`, title: name },
  summary: { description: name, industry: "Logistics", employee_estimate: 200, hq: "Austin, TX", is_operator: true },
  costDollars: { total: 0.009 },
})) as never;

/** Accept everything; the dry run exercises memory and reporting, not the gate (gates have their own tests). */
export const fakeCheckLead: LeadChecker = (_plan, input) => ({
  ok: true,
  details: {
    key: squashName(input.company), event_date: "2026-10-01", date_source: "signal", employees: 200,
    size_basis: "quoted", required_gates_passed: ["is_operator"], optional_gates_passed: [],
    hq: "Austin", multiplier: 1, fit_reason: "ok",
  },
});

/** Replaces driveRun in runCell: the real loop with a scripted model and canned Exa. */
export const fakeDriveRun: NonNullable<RunCellDeps["driveRun"]> = (state: RunState, deps: LoopDeps, policy, options) => {
  const informed = state.caches.seenKeys.length > 0;
  return driveRun(
    state,
    { ...deps, client: scriptedClient(informed ? informedScript() : freshScript()), exaSearch: fakeExaSearch, lookupCompany: fakeLookupCompany },
    policy,
    options,
  );
};

/** Canned judge: everything is a yes except SecondCo's size (Q2 = no), so good < leads somewhere. */
export const fakeJudgeClient = {
  messages: { create: async (params: { messages: Array<{ content: unknown }> }) => {
    const prompt = JSON.stringify(params.messages[0]?.content ?? "");
    const q2 = /SecondCo/.test(prompt) ? "no" : "yes";
    return {
      content: [{ type: "text", text: JSON.stringify({ q1: "yes", q1_source: "https://fake.example/q1", q2, q2_source: "https://fake.example/q2", q3: "yes", q3_source: "https://fake.example/q3", note: "dry-run judge, via corroborating source" }) }],
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  } },
} as never;
