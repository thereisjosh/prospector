import { describe, expect, it } from "vitest";
import {
  buildCompanySchema,
  buildSignalSchema,
  composeCompanySummaryQuery,
  composeSignalSummaryQuery,
  normalizeNullish,
  normalizeSignalDate,
  validatePlan,
  type SearchPlan,
} from "../src/plan";
import { V1_PLAN_1, V1_PLAN_2, V1_PLAN_3 } from "./fixtures/v1-plans";

const basePlan = (): SearchPlan => ({
  label: "Test plan",
  months: 3,
  signalQueries: ["company opening a new facility"],
  signalSummaryQuery: "the facility and its date",
  companySummaryQuery: "firmographics",
  gateFields: [{ key: "is_operator", question: "Is it an operator?", required: true }],
  employeeRange: { min: 10, max: 500, unknownPolicy: "allow-if-not-enterprise" },
  hqCountries: ["US"],
  excludeDomains: ["example.com"],
  excludeNames: ["BigCo"],
  signalTypes: ["new_facility", "ops_hire"],
});

function errorsFor(mutate: (p: Record<string, unknown>) => void): string[] {
  const p = basePlan() as unknown as Record<string, unknown>;
  mutate(p);
  const result = validatePlan(p);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors;
}

describe("validatePlan", () => {
  it("accepts a valid plan and the three v1 fixtures", () => {
    for (const plan of [basePlan(), V1_PLAN_1, V1_PLAN_2, V1_PLAN_3]) {
      const result = validatePlan(plan);
      expect(result.ok).toBe(true);
    }
  });

  it("returns a normalised copy (trims, lowercases domains)", () => {
    const p = basePlan();
    p.excludeDomains = [" WWW.Example.COM "];
    p.label = "  padded  ";
    const result = validatePlan(p);
    expect(result.ok && result.plan.excludeDomains).toEqual(["example.com"]);
    expect(result.ok && result.plan.label).toBe("padded");
  });

  it("rejects non-objects", () => {
    expect(validatePlan(null).ok).toBe(false);
    expect(validatePlan("plan").ok).toBe(false);
    expect(validatePlan([]).ok).toBe(false);
  });

  it("enforces months 1-12 integer", () => {
    for (const months of [0, 13, 2.5, "3", NaN]) {
      expect(errorsFor((p) => (p.months = months)).join()).toMatch(/months/);
    }
    for (const months of [1, 12]) {
      expect(validatePlan({ ...basePlan(), months }).ok).toBe(true);
    }
  });

  it("enforces signalQueries 1-8 non-empty", () => {
    expect(errorsFor((p) => (p.signalQueries = [])).join()).toMatch(/signalQueries/);
    expect(
      errorsFor((p) => (p.signalQueries = Array.from({ length: 9 }, (_, i) => `q${i}`))).join(),
    ).toMatch(/signalQueries/);
    expect(errorsFor((p) => (p.signalQueries = ["ok", "   "])).join()).toMatch(/signalQueries\[1\]/);
  });

  it("enforces gate caps, key format and core-key collisions", () => {
    const gate = (key: string) => ({ key, question: "q?", required: false });
    expect(
      errorsFor((p) => (p.gateFields = Array.from({ length: 7 }, (_, i) => gate(`gate_${i}`)))).join(),
    ).toMatch(/at most 6/);
    expect(errorsFor((p) => (p.gateFields = [gate("Bad-Key")])).join()).toMatch(/key must match/);
    expect(errorsFor((p) => (p.gateFields = [gate("x")])).join()).toMatch(/key must match/);
    for (const core of ["description", "industry", "employee_estimate", "employee_estimate_source", "is_public_or_enterprise", "hq"]) {
      expect(errorsFor((p) => (p.gateFields = [gate(core)])).join()).toMatch(/collides/);
    }
    expect(errorsFor((p) => (p.gateFields = [gate("dup_key"), gate("dup_key")])).join()).toMatch(/duplicated/);
    expect(validatePlan({ ...basePlan(), gateFields: [] }).ok).toBe(true);
  });

  it("enforces signalTypes 1-8 snake_case, no 'other'", () => {
    expect(errorsFor((p) => (p.signalTypes = [])).join()).toMatch(/signalTypes/);
    expect(
      errorsFor((p) => (p.signalTypes = Array.from({ length: 9 }, (_, i) => `type_${i}`))).join(),
    ).toMatch(/signalTypes/);
    expect(errorsFor((p) => (p.signalTypes = ["Not Snake"])).join()).toMatch(/snake_case/);
    expect(errorsFor((p) => (p.signalTypes = ["other"])).join()).toMatch(/other/);
  });

  it("enforces employeeRange min <= max and unknownPolicy", () => {
    expect(errorsFor((p) => (p.employeeRange = { min: 500, max: 10, unknownPolicy: "reject" })).join()).toMatch(
      /min must be <=/,
    );
    expect(errorsFor((p) => (p.employeeRange = { min: 1, max: 2, unknownPolicy: "maybe" })).join()).toMatch(
      /unknownPolicy/,
    );
  });

  it("enforces hqCountries ISO-2 uppercase ([] = any)", () => {
    expect(errorsFor((p) => (p.hqCountries = ["us"])).join()).toMatch(/hqCountries/);
    expect(errorsFor((p) => (p.hqCountries = ["USA"])).join()).toMatch(/hqCountries/);
    expect(validatePlan({ ...basePlan(), hqCountries: [] }).ok).toBe(true);
  });

  it('requires followUp.queryTemplate to contain "{company}"', () => {
    expect(
      errorsFor((p) => (p.followUp = { queryTemplate: "hiring ops", summaryQuery: "s" })).join(),
    ).toMatch(/\{company\}/);
    const ok = validatePlan({
      ...basePlan(),
      followUp: { queryTemplate: "{company} hiring ops", summaryQuery: "s" },
    });
    expect(ok.ok && ok.plan.followUp?.queryTemplate).toBe("{company} hiring ops");
  });

  it("rejects bad excludeDomains and reports every error at once", () => {
    const errors = errorsFor((p) => {
      p.excludeDomains = ["https://example.com/path"];
      p.months = 99;
    });
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("schema builders", () => {
  it("buildSignalSchema: enum = signalTypes + other, all required, closed", () => {
    const schema = buildSignalSchema(basePlan());
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["company_name", "signal_type", "signal_summary", "signal_date", "signal_quote", "signal_date_quote"]);
    expect(Object.keys(schema.properties).sort()).toEqual([...schema.required].sort());
    expect(schema.properties.signal_type).toEqual({
      type: "string",
      enum: ["new_facility", "ops_hire", "other"],
    });
    expect(schema.properties.signal_date.type).toBe("string");
  });

  it("buildSignalSchema has no pre-screen fields and the query requires verbatim evidence quotes", () => {
    const plan = basePlan();
    expect(Object.keys(buildSignalSchema(plan).properties)).toEqual([
      "company_name", "signal_type", "signal_summary", "signal_date", "signal_quote", "signal_date_quote",
    ]);
    expect(composeSignalSummaryQuery(plan, "the signal")).toContain("For signal_quote, copy the exact sentence");
    expect(composeSignalSummaryQuery(plan, "the signal")).toContain("For signal_date_quote, copy the exact date phrase");
  });

  it("composeCompanySummaryQuery asks for the employee-estimate source quote", () => {
    expect(composeCompanySummaryQuery(basePlan())).toContain("employee_estimate_source");
    expect(composeCompanySummaryQuery({ ...basePlan(), gateFields: [] })).toContain("employee_estimate_source");
  });

  it("buildCompanySchema: core props + one boolean per gate, all required, closed", () => {
    const plan = basePlan();
    plan.gateFields.push({ key: "is_funded", question: "Funded?", required: false });
    const schema = buildCompanySchema(plan);
    const props = schema.properties as Record<string, { type?: unknown }>;
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(props)).toEqual([
      "description",
      "industry",
      "employee_estimate",
      "employee_estimate_source",
      "is_public_or_enterprise",
      "hq",
      "hq_quote",
      "is_operator",
      "is_operator_quote",
      "is_funded",
      "is_funded_quote",
    ]);
    expect(props.is_operator).toEqual({ anyOf: [{ type: "boolean" }, { type: "null" }] });
    expect(props.is_operator_quote).toEqual({ type: "string" });
    expect(props.is_funded).toEqual({ anyOf: [{ type: "boolean" }, { type: "null" }] });
    expect(props.is_funded_quote).toEqual({ type: "string" });
    expect(props.is_public_or_enterprise).toEqual({ type: "boolean" });
    expect(props.employee_estimate_source).toEqual({ type: "string" });
    expect(props.employee_estimate).toEqual({ anyOf: [{ type: "number" }, { type: "string" }] });
    expect([...schema.required].sort()).toEqual(Object.keys(props).sort());
  });
});

describe("normalizeNullish", () => {
  it('treats "null", "none", "n/a", "", whitespace as undefined', () => {
    for (const v of ["null", "NULL", " null ", "none", "None", "n/a", "N/A", "", "   ", null, undefined]) {
      expect(normalizeNullish(v)).toBeUndefined();
    }
  });

  it("trims strings (T0: ' asos')", () => {
    expect(normalizeNullish(" asos")).toBe("asos");
    expect(normalizeNullish("  Love, Bonito ")).toBe("Love, Bonito");
  });

  it("trims array items and drops nullish ones", () => {
    expect(normalizeNullish([" asos", "null", "zalora ", "", "  "])).toEqual(["asos", "zalora"]);
    expect(normalizeNullish([])).toEqual([]);
  });

  it("passes through non-strings", () => {
    expect(normalizeNullish(0)).toBe(0);
    expect(normalizeNullish(false)).toBe(false);
    expect(normalizeNullish(120)).toBe(120);
  });
});

describe("normalizeSignalDate", () => {
  it("handles the T0 formats", () => {
    expect(normalizeSignalDate("2026-04-15")).toBe("2026-04-15");
    expect(normalizeSignalDate("Oct 1, 2026")).toBe("2026-10-01");
  });

  it("handles long month names and day-first formats", () => {
    expect(normalizeSignalDate("1 October 2026")).toBe("2026-10-01");
    expect(normalizeSignalDate("October 1st, 2026")).toBe("2026-10-01");
    expect(normalizeSignalDate("15 Sept 2026")).toBe("2026-09-15");
    expect(normalizeSignalDate("Dec 31, 2025")).toBe("2025-12-31");
  });

  it("handles ISO datetimes without timezone shifting the date", () => {
    expect(normalizeSignalDate("2026-04-15T23:30:00.000Z")).toBe("2026-04-15");
    expect(normalizeSignalDate("2026-04-15T00:00:00+08:00")).toBe("2026-04-15");
    expect(normalizeSignalDate("2026-04-15 10:00")).toBe("2026-04-15");
  });

  it("returns undefined for nullish, unparseable, month-only and impossible dates", () => {
    for (const v of ["null", "", "unknown", "October 2026", "2026-02-30", "Foo 1, 2026", "2026", undefined, null, 5]) {
      expect(normalizeSignalDate(v)).toBeUndefined();
    }
  });
});
