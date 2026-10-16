import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  describeChange,
  eventLine,
  groupRejections,
  leadsCsv,
  plainText,
  suggestionTitle,
  rejectionPhrase,
  suggestionPatch,
  type ContractView,
} from "../app/ui/copy";
import type { AgentEvent } from "../src/agent/events";
import type { CardSet } from "../src/planner/cards";

const DEMO = join(import.meta.dirname, "demo");
const state = JSON.parse(readFileSync(join(DEMO, "run", "state.json"), "utf8"));
const events = readFileSync(join(DEMO, "run", "events.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as AgentEvent);
const cards = JSON.parse(readFileSync(join(DEMO, "planner", "cards.json"), "utf8")).cards as CardSet;
const contract = (state.initialContract ?? state.contract) as ContractView;
// Fixed contract for exact-wording assertions, independent of whichever recording is in eval/demo.
const fixed = { ...contract, months: 3, employeeRange: { min: 100, max: 1000, unknownPolicy: "allow-if-not-enterprise" },
  gateFields: [{ key: "is_third_party_logistics", question: "provides warehousing or fulfillment services to other companies (not a brand)", required: true }],
} as ContractView;

// Anything that looks like an internal code: snake_case words or "required_gate:".
const CODE = /\b[a-z]+_[a-z_]+\b|required_gate|\bgate\b|schema|json/i;

describe("plain-words copy", () => {
  it("turns every recorded event into a sentence with no internal codes", () => {
    const lines = events.map((e) => eventLine(e, contract)).filter(Boolean);
    expect(lines.length).toBeGreaterThan(20);
    for (const line of lines) expect(line!.text).not.toMatch(CODE);
  });

  it("says why a company was turned down, with numbers", () => {
    expect(rejectionPhrase("size", "unverified estimate 3,560 is far outside 100–1000", fixed)).toBe("too large (3,560 employees)");
    expect(rejectionPhrase("size", "unverified estimate 9 is far outside 100–1000", fixed)).toBe("too small (9 employees)");
    expect(rejectionPhrase("hq", 'HQ "Amman, Jordan" is outside US/GB', contract)).toBe("based outside your countries (Amman, Jordan)");
    const gate = rejectionPhrase("required_gate:is_third_party_logistics", "required gate(s) not satisfied: is_third_party_logistics", fixed);
    expect(gate).toMatch(/^not a match: provides warehousing/);
    expect(gate).not.toMatch(CODE);
  });

  it("judges size direction by the range in force when the company was checked", () => {
    const widened = { ...fixed, employeeRange: { min: 100, max: 2000, unknownPolicy: "allow-if-not-enterprise" } } as ContractView;
    expect(rejectionPhrase("size", "unverified estimate 1,707 is far outside 100–1000", widened)).toBe("too large (1,707 employees)");
  });

  it("groups rejections by reason with counts, without codes", () => {
    const groups = groupRejections(state.rejected, contract);
    expect(groups.reduce((n, g) => n + g.items.length, 0)).toBe(state.rejected.length);
    for (const g of groups) expect(g.label).not.toMatch(CODE);
    const synthetic = groupRejections(
      [
        { company: "A", code: "size", reason: "employee estimate 3,560 is outside the approximate 100-1000 target" },
        { company: "B", code: "size", reason: "unverified estimate 1,707 is far outside 100–1000" },
        { company: "C", code: "size", reason: "unverified estimate 9 is far outside 100–1000" },
        { company: "D", code: "stale_date", reason: "event date 2026-01-02 is outside the 3-month window" },
      ],
      fixed,
    );
    expect(synthetic.map((g) => [g.label, g.items.length])).toEqual([
      ["Too large", 2],
      ["Too small", 1],
      ["News older than the time window", 1],
    ]);
  });

  it("maps handback suggestions to card edits", () => {
    const size = suggestionPatch({ field: "employeeRange", value: { min: 20, max: 2000 }, why: "" }, cards, 1);
    expect(size?.cards.size).toEqual({ min: 20, max: 2000, unknownPolicy: cards.size.unknownPolicy });
    expect(suggestionPatch({ field: "months", value: 6, why: "" }, cards, 1)?.cards.recency.months).toBe(6);
    expect(suggestionPatch({ field: "hqCountries", value: "any", why: "" }, cards, 1)?.cards.geo.hqCountries).toEqual([]);
    expect(suggestionPatch({ field: "maxCostDollars", value: 2, why: "" }, cards, 1)?.maxCost).toBe(2);
    expect(suggestionPatch({ field: "is_third_party_logistics", value: "relax", why: "" }, cards, 1)).toBeNull();
  });

  it("rewrites codes in harness text but leaves prose alone", () => {
    expect(plainText("Rejections clustered around enterprise.", fixed)).toBe("Rejections clustered around large enterprise or public company.");
    expect(plainText("Required gate required_gate:is_third_party_logistics blocked candidates.", fixed)).not.toMatch(/required_gate|_/);
    expect(plainText("Several candidates missed the size range.", fixed)).toBe("Several candidates missed the size range.");
    expect(suggestionTitle("scope", "review", fixed)).toBe("Review your targeting");
  });

  it("describes scope changes in words", () => {
    expect(describeChange("employeeRange", { min: 100, max: 2000 }, fixed)).toBe("Company size: 100–1,000 employees → 100–2,000 employees");
    expect(describeChange("months", 6, fixed)).toBe("Look back 6 months instead of 3");
  });

  it("exports leads as CSV with quoting", () => {
    const csv = leadsCsv(state.leads);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(state.leads.length + 1);
    expect(lines[0]).toBe("Company,Why now,Event date,Size,Size basis,Fit,Source,Your verdict,Your note,Contact names,Contact titles,Contact tiers,Contact profile URLs,Contact evidence URLs");
    expect(csv).toContain("https://");
  });
});

describe("HTTP error copy", () => {
  it("maps 402 on planner routes to the allowance message, never a card/validation message", async () => {
    const { httpErrorMessage } = await import("../app/ui/copy");
    const msg = httpErrorMessage(402, "planner", { code: "allowance_exhausted", limitDollars: 2.5 })!;
    expect(msg).toBe("You've used your free allowance on this site ($2.50). Run it locally with your own keys (see README) or try a private window.");
    expect(msg).not.toMatch(/cards|loosen|plan/i);
  });
  it("maps 402 on run creation to the free-runs message with N", async () => {
    const { httpErrorMessage } = await import("../app/ui/copy");
    expect(httpErrorMessage(402, "run", { runLimit: 3 })).toBe("You've used your 3 free runs here.");
  });
  it("maps 503 daily_budget_reached, 429, and leaves real 5xx / 400 to the generic copy", async () => {
    const { httpErrorMessage } = await import("../app/ui/copy");
    expect(httpErrorMessage(503, "planner", { code: "daily_budget_reached" })).toBe("This site has reached its daily budget; try tomorrow or run locally.");
    expect(httpErrorMessage(429, "run")).toBe("Too many requests; wait a moment.");
    expect(httpErrorMessage(500, "planner")).toBeUndefined();
    expect(httpErrorMessage(503, "planner", { code: "other" })).toBeUndefined();
    expect(httpErrorMessage(400, "planner")).toBeUndefined();
  });
  it("every 4xx/503 status the API documents has a specific message", async () => {
    const { httpErrorMessage } = await import("../app/ui/copy");
    for (const [status, code] of [[402, "allowance_exhausted"], [429, "Too many requests."], [503, "daily_budget_reached"]] as const) {
      for (const where of ["planner", "run"] as const) expect(httpErrorMessage(status, where, { code })).toBeTruthy();
    }
  });
  it("shows the remaining allowance line", async () => {
    const { allowanceLine } = await import("../app/ui/copy");
    expect(allowanceLine({ remainingRuns: 2, remainingDollars: 1.63 })).toBe("Free runs left on this site: 2 · $1.63");
  });
});
