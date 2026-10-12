import { estimateExaCost } from "../exa";
import { validatePlan, type GateField, type SearchPlan } from "../plan";
import { callClaudeJson, cleanString, isRecord, type PlannerModelDeps } from "./claude";
import type { CardSet } from "./cards";

type CompileModelOutput = {
  signalQueries: string[];
  gateFields: GateField[];
  signalSummaryQuery: string;
  companySummaryQuery: string;
};

export async function compilePlan(cards: CardSet, deps: PlannerModelDeps): Promise<{
  plan: SearchPlan;
  cost: number;
  estimatedRunCost: number;
}> {
  const system = [
    "You compile editable prospecting cards into the missing SearchPlan text fields.",
    "Reply with ONE JSON object and nothing else.",
    "Return signalQueries: exactly 5 meaning-phrased search queries, each targeting one chosen signal type.",
    "Return gateFields: at most 4 positively phrased yes/no questions. The first gate is required and expresses the who target.",
    "Return signalSummaryQuery and companySummaryQuery for Exa summaries.",
  ].join("\n");
  const { value, cost } = await callClaudeJson(
    deps,
    system,
    JSON.stringify(cards),
    (json) => validateCompileOutput(json, cards),
  );
  const plan: SearchPlan = {
    label: `${cards.who.descriptor} with ${cards.whyNow.description}`.slice(0, 160),
    months: cards.recency.months,
    signalQueries: value.signalQueries,
    signalSummaryQuery: value.signalSummaryQuery,
    companySummaryQuery: value.companySummaryQuery,
    gateFields: value.gateFields,
    employeeRange: cards.size,
    hqCountries: cards.geo.hqCountries,
    excludeDomains: cards.exclusions.domains,
    excludeNames: cards.exclusions.names,
    signalTypes: cards.whyNow.signalTypes,
  };
  const valid = validatePlan(plan);
  if (!valid.ok) {
    throw new Error(`compilePlan produced invalid plan after model validation: ${valid.errors.join("; ")}`);
  }
  return { plan: valid.plan, cost, estimatedRunCost: estimateRunCost() };
}

function validateCompileOutput(input: unknown, cards: CardSet) {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false as const, errors: ["output must be an object"] };
  const signalQueries = Array.isArray(input.signalQueries)
    ? input.signalQueries.filter((q): q is string => typeof q === "string" && q.trim().length > 0).map((q) => q.trim())
    : [];
  if (signalQueries.length !== 5) errors.push("signalQueries must have exactly 5 items");

  const signalSummaryQuery = cleanString(input.signalSummaryQuery);
  if (!signalSummaryQuery) errors.push("signalSummaryQuery must be a non-empty string");
  const companySummaryQuery = cleanString(input.companySummaryQuery);
  if (!companySummaryQuery) errors.push("companySummaryQuery must be a non-empty string");

  const gateFields: GateField[] = [];
  if (!Array.isArray(input.gateFields)) {
    errors.push("gateFields must be an array");
  } else {
    if (input.gateFields.length > 4) errors.push("gateFields must have at most 4 items");
    input.gateFields.forEach((gate, i) => {
      if (!isRecord(gate)) {
        errors.push(`gateFields[${i}] must be an object`);
        return;
      }
      const key = cleanString(gate.key);
      const question = cleanString(gate.question);
      if (!key || !/^[a-z][a-z0-9_]{1,40}$/.test(key)) errors.push(`gateFields[${i}].key must be snake_case`);
      if (!question || !/\?$/.test(question)) errors.push(`gateFields[${i}].question must be a yes/no question`);
      if (typeof gate.required !== "boolean") errors.push(`gateFields[${i}].required must be boolean`);
      if (key && question && typeof gate.required === "boolean") {
        gateFields.push({ key, question, required: gate.required });
      }
    });
  }
  if (gateFields[0]?.required !== true) errors.push("gateFields[0] must be required");

  if (errors.length) return { ok: false as const, errors };
  const candidate: SearchPlan = {
    label: `${cards.who.descriptor} with ${cards.whyNow.description}`.slice(0, 160),
    months: cards.recency.months,
    signalQueries,
    signalSummaryQuery: signalSummaryQuery!,
    companySummaryQuery: companySummaryQuery!,
    gateFields,
    employeeRange: cards.size,
    hqCountries: cards.geo.hqCountries,
    excludeDomains: cards.exclusions.domains,
    excludeNames: cards.exclusions.names,
    signalTypes: cards.whyNow.signalTypes,
  };
  const planValidation = validatePlan(candidate);
  if (!planValidation.ok) return { ok: false as const, errors: planValidation.errors };
  return {
    ok: true as const,
    value: {
      signalQueries,
      signalSummaryQuery: signalSummaryQuery!,
      companySummaryQuery: companySummaryQuery!,
      gateFields,
    },
  };
}

function estimateRunCost(): number {
  const signalSearch = estimateExaCost({
    query: "placeholder",
    numResults: 25,
    contents: { summary: { query: "placeholder" } },
  });
  const companyLookup = estimateExaCost({
    query: "placeholder",
    category: "company",
    numResults: 2,
    contents: { summary: { query: "placeholder" } },
  });
  return Math.round((5 * signalSearch + 30 * companyLookup + 0.30) * 100) / 100;
}
