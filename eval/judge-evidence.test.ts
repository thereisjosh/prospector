import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const tmp = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "judge-evidence-test-"));
  process.env.RUNS_DIR = join(root, "runs");
  return { runs: join(root, "runs") };
});

import { judgeContractFromPlan, judgeLeadFromState, judgePayload } from "../src/agent/judge-input";
import { createRunState, loadState, type AcceptedLead } from "../src/agent/state";
import { mask } from "../src/agent/trace";
import { ACCEPTED_LEAD_CHECKS, EXCERPT_MAX, emptyJudgeEvidence, judgeEvidence, mentionOffsets, signalEvidence, signalExcerpt } from "../src/evidence";
import type { GateCode } from "../src/gates";
import { getV1Plan } from "./fixtures/v1-plans";

const lead = { company: "RGL Logistics", signal_url: "https://news.example/rgl", why_now: "RGL opened a 427,500 sq ft warehouse", event_date: "2026-10-05", size_basis: "quoted" };
const filler = (n: number, word = "lorem") => Array.from({ length: n }, () => word).join(" ");

describe("judge payload evidence", () => {
  it("evidence is always present and last; without evidence its fields are empty", () => {
    const without = judgePayload(lead);
    expect(Object.keys(without)).toEqual(["company", "signal_url", "why_now", "contract_summary", "evidence"]);
    expect(without.evidence).toEqual({ signal_title: "", signal_published_date: "", signal_excerpt: "", company_lookup: null, gate_result: null });

    const evidence = judgeEvidence({
      signal: signalEvidence({ title: "RGL unveils warehouse", publishedDate: "2026-10-05T00:00:00.000Z", text: "RGL Logistics completed a new warehouse." }, lead.company, lead.why_now),
      enrichment: { description: "x".repeat(900), industry: "Logistics", hq: "Green Bay, US", employee_estimate: 232, employee_estimate_source: "Employees: 232", is_public_or_enterprise: false, is_third_party_logistics: true, has_cold_storage: false, company_name: "RGL" },
      details: { key: "rgllogistics", event_date: "2026-10-05", date_source: "signal", employees: 232, size_basis: "quoted", required_gates_passed: ["is_third_party_logistics"], optional_gates_passed: [], hq: "Green Bay, US", hq_basis: "enrichment", multiplier: 1, fit_reason: "required gates passed: …" },
    });
    const contract = judgeContractFromPlan(getV1Plan(1), new Date("2026-10-12T00:00:00Z"));
    const withEv = judgePayload({ ...lead, contract, evidence });
    expect(Object.keys(withEv)).toEqual(["company", "signal_url", "why_now", "contract", "contract_summary", "evidence"]);
    expect(Object.keys(withEv.evidence)).toEqual(["signal_title", "signal_published_date", "signal_excerpt", "company_lookup", "gate_result"]);
    expect(withEv.evidence.company_lookup!.description.length).toBeLessThanOrEqual(600);
    expect(withEv.evidence.company_lookup!.gate_fields).toEqual({ has_cold_storage: false, is_third_party_logistics: true });
    expect(withEv.evidence.gate_result).toEqual({
      checks_passed: [...ACCEPTED_LEAD_CHECKS, "required_gate:is_third_party_logistics"],
      date_source: "signal",
      employees: 232,
      hq: "Green Bay, US",
      hq_basis: "enrichment",
      required_gates_passed: ["is_third_party_logistics"],
      optional_gates_passed: [],
    });
    // No arm-specific fields from details (fit sentence, score multiplier, dedupe key).
    expect(JSON.stringify(withEv)).not.toMatch(/fit_reason|multiplier|rgllogistics/);
  });

  it("the accepted-lead checks are real gate codes (and omit the run-history checks only the agent applies)", () => {
    const codes: readonly GateCode[] = ACCEPTED_LEAD_CHECKS;
    expect(codes).not.toContain("already_seen");
    expect(codes).not.toContain("duplicate");
  });
});

describe("signal excerpt window", () => {
  it("returns short text whole (whitespace collapsed)", () => {
    expect(signalExcerpt("Acme  opened\n\na DC.", "Acme")).toBe("Acme opened a DC.");
  });

  it("anchors on the company mention with lead-in context, within the limit", () => {
    const text = `${filler(400)} Dateline Appleton. RGL Logistics completed a new 427,500 sq ft warehouse. ${filler(400)}`;
    const out = signalExcerpt(text, "RGL Logistics", "opened a warehouse");
    expect(out.length).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(out).toContain("Dateline Appleton. RGL Logistics completed a new 427,500 sq ft warehouse.");
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });

  it("among several mentions, picks the window that also holds the event", () => {
    const text = `RGL Logistics newsletter. ${filler(600)} Separately, RGL Logistics completed a new warehouse in Appleton. ${filler(300)}`;
    const out = signalExcerpt(text, "RGL Logistics", "RGL completed a new warehouse in Appleton");
    expect(out).toContain("completed a new warehouse in Appleton");
  });

  it("matches the gate's name rule: suffixes, '&', squashed long names; no substring hits for short names", () => {
    expect(mentionOffsets("Southern AG Carriers, Inc.", "news: Southern AG Carriers expands")).toEqual([6]);
    expect(mentionOffsets("Smith and Sons", "Smith & Sons opened")).toEqual([0]);
    expect(mentionOffsets("Diakon Logistics", "x Diakonlogistics y")).toEqual([2]);
    expect(mentionOffsets("UPS", "startups everywhere")).toEqual([]);
  });

  it("falls back to the start of the text when the company is not mentioned", () => {
    const text = `Headline here. ${filler(600)}`;
    const out = signalExcerpt(text, "Nowhere Co", "opened");
    expect(out.startsWith("Headline here.")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(EXCERPT_MAX);
  });
});

describe("old persisted runs", () => {
  it("a state.json written before AcceptedLead.evidence loads and judges with empty signal fields", async () => {
    const s = createRunState({ id: "11111111-1111-4111-8111-111111111111", workspaceId: "ws-old", plan: getV1Plan(1), createdAt: "2026-10-12T00:00:00.000Z" });
    const old: Omit<AcceptedLead, "evidence"> = {
      company: "OldCo",
      signal_url: "https://news.example/old",
      why_now: "opened a DC",
      summary: { company_name: "OldCo", signal_type: "expansion", signal_summary: "x", signal_date: "2026-10-01" },
      enrichment: { description: "OldCo is a 3PL", employee_estimate: 300, employee_estimate_source: "300 staff", is_third_party_logistics: true },
      details: { event_date: "2026-10-01", size_basis: "quoted", required_gates_passed: ["is_third_party_logistics"] },
      turn: 2,
    };
    s.leads.push(old as AcceptedLead);
    mkdirSync(join(tmp.runs, s.id), { recursive: true });
    writeFileSync(join(tmp.runs, s.id, "state.json"), JSON.stringify(s));
    const loaded = await loadState(s.id);
    const payload = judgePayload({ ...judgeLeadFromState(loaded.leads[0]!), contract: judgeContractFromPlan(loaded.contract, new Date(loaded.createdAt)) });
    expect(payload.evidence).toMatchObject({ signal_title: "", signal_published_date: "", signal_excerpt: "" });
    expect(payload.evidence.company_lookup).toMatchObject({ description: "OldCo is a 3PL", employee_estimate: 300 });
    expect(payload.evidence.gate_result?.required_gates_passed).toEqual(["is_third_party_logistics"]);
    // A lead with neither enrichment nor details is still valid: all empty.
    expect(judgeLeadFromState({ ...old, enrichment: undefined, details: {} } as AcceptedLead).evidence).toEqual(emptyJudgeEvidence());
  });
});

describe("masking at the trace boundary keeps ordinary page text", () => {
  it("a realistic excerpt survives masking: URL slugs, dates, figures intact; only the email is redacted", () => {
    const excerpt =
      "RGL Logistics unveils new warehouse in Appleton - The Business News. October 5, 2026 APPLETON – RGL Logistics completed a new 427,500 sq ft warehouse (its 29th building) at https://thebusinessnews.com/northeast/rgl-logistics-unveils-new-warehouse-in-appleton/ and https://www.citybiz.co/article/916149/capacity-llc-acquires-majority-stake-in-uk-based-core-fulfilment-expanding-transatlantic-logistics-network/ . Funding: $15M Series A, 1,100-1,800 staff, 09:30 ribbon cutting. Media: press@rgl-logistics.example.com.";
    const payload = judgePayload({ ...lead, evidence: judgeEvidence({ signal: { signal_title: "RGL Logistics unveils new warehouse", signal_published_date: "2026-10-05T00:00:00.000Z", signal_excerpt: excerpt } }) });
    const masked = mask(payload, { workspaceId: "ws-123456" });
    expect(masked.evidence.signal_excerpt).toBe(excerpt.replace("press@rgl-logistics.example.com", "[redacted:email]"));
    expect(masked.evidence.signal_title).toBe("RGL Logistics unveils new warehouse");
    expect(masked.evidence.signal_published_date).toBe("2026-10-05T00:00:00.000Z");
    expect(JSON.stringify(masked)).not.toContain("[redacted:blob]");
  });
});
