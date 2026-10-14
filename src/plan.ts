/**
 * SearchPlan: the single object that drives the generic prospecting engine.
 * v1 hand-wrote three of these as IcpConfigs; v2 will have a Claude planner
 * generate them. Everything the engine does is parameterised by this type, and
 * every plan - hand-written or generated - must pass validatePlan().
 */

export type GateField = {
  /** snake_case key; becomes a boolean property in the company schema. */
  key: string;
  /** Yes/no question Exa answers about the company. */
  question: string;
  /** Required gates must be true for a company to be kept. */
  required: boolean;
};

export type SearchPlan = {
  label: string;
  months: number; // 1..12
  signalQueries: string[]; // 1..8, meaning-phrased
  signalSummaryQuery: string;
  /** Per-company probe. queryTemplate must contain "{company}". */
  followUp?: { queryTemplate: string; summaryQuery: string };
  companySummaryQuery: string;
  gateFields: GateField[]; // <= 6
  employeeRange: {
    min: number;
    max: number;
    unknownPolicy: "allow-if-not-enterprise" | "reject";
  };
  hqCountries: string[]; // ISO-2 uppercase; [] = any
  excludeDomains: string[];
  excludeNames: string[];
  /** 2-8 snake_case signal types, ordered most -> least valuable. */
  signalTypes: string[];
};

export const OTHER_SIGNAL_TYPE = "other";

/** Keys the company schema already defines; gates may not reuse them. */
export const CORE_COMPANY_KEYS = [
  "description",
  "industry",
  "employee_estimate",
  "employee_estimate_source",
  "is_public_or_enterprise",
  "hq",
] as const;

const KEY_RE = /^[a-z][a-z0-9_]{1,40}$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export const PLAN_LIMITS = {
  minMonths: 1,
  maxMonths: 12,
  minSignalQueries: 1,
  maxSignalQueries: 8,
  maxGateFields: 6,
  minSignalTypes: 1,
  maxSignalTypes: 8,
  maxQueryChars: 400,
  maxExcludeDomains: 100,
  maxExcludeNames: 300,
} as const;

export type PlanValidation =
  | { ok: true; plan: SearchPlan }
  | { ok: false; errors: string[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown, max: number = PLAN_LIMITS.maxQueryChars): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 && t.length <= max ? t : undefined;
}

export function validatePlan(input: unknown): PlanValidation {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: ["plan must be an object"] };
  }

  const label = nonEmptyString(input.label, 160);
  if (!label) errors.push("label must be a non-empty string (<=160 chars)");

  const months = input.months;
  if (
    typeof months !== "number" ||
    !Number.isInteger(months) ||
    months < PLAN_LIMITS.minMonths ||
    months > PLAN_LIMITS.maxMonths
  ) {
    errors.push(`months must be an integer ${PLAN_LIMITS.minMonths}-${PLAN_LIMITS.maxMonths}`);
  }

  const signalQueries: string[] = [];
  if (!Array.isArray(input.signalQueries)) {
    errors.push("signalQueries must be an array");
  } else {
    if (
      input.signalQueries.length < PLAN_LIMITS.minSignalQueries ||
      input.signalQueries.length > PLAN_LIMITS.maxSignalQueries
    ) {
      errors.push(
        `signalQueries must have ${PLAN_LIMITS.minSignalQueries}-${PLAN_LIMITS.maxSignalQueries} items`,
      );
    }
    input.signalQueries.forEach((q, i) => {
      const t = nonEmptyString(q);
      if (!t) errors.push(`signalQueries[${i}] must be a non-empty string (<=${PLAN_LIMITS.maxQueryChars} chars)`);
      else signalQueries.push(t);
    });
  }

  const signalSummaryQuery = nonEmptyString(input.signalSummaryQuery, 1000);
  if (!signalSummaryQuery) errors.push("signalSummaryQuery must be a non-empty string");

  const companySummaryQuery = nonEmptyString(input.companySummaryQuery, 2000);
  if (!companySummaryQuery) errors.push("companySummaryQuery must be a non-empty string");

  let followUp: SearchPlan["followUp"];
  if (input.followUp !== undefined && input.followUp !== null) {
    if (!isRecord(input.followUp)) {
      errors.push("followUp must be an object when present");
    } else {
      const queryTemplate = nonEmptyString(input.followUp.queryTemplate);
      const summaryQuery = nonEmptyString(input.followUp.summaryQuery, 1000);
      if (!queryTemplate || !queryTemplate.includes("{company}")) {
        errors.push('followUp.queryTemplate must be a non-empty string containing "{company}"');
      }
      if (!summaryQuery) errors.push("followUp.summaryQuery must be a non-empty string");
      if (queryTemplate && summaryQuery && queryTemplate.includes("{company}")) {
        followUp = { queryTemplate, summaryQuery };
      }
    }
  }

  const gateFields: GateField[] = [];
  if (!Array.isArray(input.gateFields)) {
    errors.push("gateFields must be an array");
  } else {
    if (input.gateFields.length > PLAN_LIMITS.maxGateFields) {
      errors.push(`gateFields must have at most ${PLAN_LIMITS.maxGateFields} items`);
    }
    const seen = new Set<string>();
    input.gateFields.forEach((g, i) => {
      if (!isRecord(g)) {
        errors.push(`gateFields[${i}] must be an object`);
        return;
      }
      const key = typeof g.key === "string" ? g.key : "";
      if (!KEY_RE.test(key)) {
        errors.push(`gateFields[${i}].key must match ${KEY_RE.source}`);
      } else if ((CORE_COMPANY_KEYS as readonly string[]).includes(key)) {
        errors.push(`gateFields[${i}].key "${key}" collides with a core company field`);
      } else if (seen.has(key)) {
        errors.push(`gateFields[${i}].key "${key}" is duplicated`);
      }
      seen.add(key);
      const question = nonEmptyString(g.question, 600);
      if (!question) errors.push(`gateFields[${i}].question must be a non-empty string`);
      if (typeof g.required !== "boolean") errors.push(`gateFields[${i}].required must be a boolean`);
      if (KEY_RE.test(key) && question && typeof g.required === "boolean") {
        gateFields.push({ key, question, required: g.required });
      }
    });
  }

  const signalTypes: string[] = [];
  if (!Array.isArray(input.signalTypes)) {
    errors.push("signalTypes must be an array");
  } else {
    if (
      input.signalTypes.length < PLAN_LIMITS.minSignalTypes ||
      input.signalTypes.length > PLAN_LIMITS.maxSignalTypes
    ) {
      errors.push(
        `signalTypes must have ${PLAN_LIMITS.minSignalTypes}-${PLAN_LIMITS.maxSignalTypes} items`,
      );
    }
    const seen = new Set<string>();
    input.signalTypes.forEach((t, i) => {
      if (typeof t !== "string" || !KEY_RE.test(t)) {
        errors.push(`signalTypes[${i}] must be snake_case matching ${KEY_RE.source}`);
      } else if (t === OTHER_SIGNAL_TYPE) {
        errors.push(`signalTypes[${i}] must not be "${OTHER_SIGNAL_TYPE}" (it is appended automatically)`);
      } else if (seen.has(t)) {
        errors.push(`signalTypes[${i}] "${t}" is duplicated`);
      } else {
        seen.add(t);
        signalTypes.push(t);
      }
    });
  }

  let employeeRange: SearchPlan["employeeRange"] | undefined;
  if (!isRecord(input.employeeRange)) {
    errors.push("employeeRange must be an object");
  } else {
    const { min, max, unknownPolicy } = input.employeeRange;
    const okNum = (n: unknown): n is number =>
      typeof n === "number" && Number.isFinite(n) && n >= 0;
    if (!okNum(min) || !okNum(max)) {
      errors.push("employeeRange.min and .max must be non-negative finite numbers");
    } else if (min > max) {
      errors.push("employeeRange.min must be <= employeeRange.max");
    }
    if (unknownPolicy !== "allow-if-not-enterprise" && unknownPolicy !== "reject") {
      errors.push('employeeRange.unknownPolicy must be "allow-if-not-enterprise" or "reject"');
    }
    if (
      okNum(min) &&
      okNum(max) &&
      min <= max &&
      (unknownPolicy === "allow-if-not-enterprise" || unknownPolicy === "reject")
    ) {
      employeeRange = { min, max, unknownPolicy };
    }
  }

  const hqCountries: string[] = [];
  if (!Array.isArray(input.hqCountries)) {
    errors.push("hqCountries must be an array (use [] for any)");
  } else {
    input.hqCountries.forEach((c, i) => {
      if (typeof c !== "string" || !/^[A-Z]{2}$/.test(c)) {
        errors.push(`hqCountries[${i}] must be an uppercase ISO-2 code`);
      } else if (!hqCountries.includes(c)) {
        hqCountries.push(c);
      }
    });
  }

  const excludeDomains: string[] = [];
  if (!Array.isArray(input.excludeDomains)) {
    errors.push("excludeDomains must be an array");
  } else {
    if (input.excludeDomains.length > PLAN_LIMITS.maxExcludeDomains) {
      errors.push(`excludeDomains must have at most ${PLAN_LIMITS.maxExcludeDomains} items`);
    }
    input.excludeDomains.forEach((d, i) => {
      const t = typeof d === "string" ? d.trim().toLowerCase().replace(/^www\./, "") : "";
      if (!DOMAIN_RE.test(t)) errors.push(`excludeDomains[${i}] must be a bare domain like example.com`);
      else if (!excludeDomains.includes(t)) excludeDomains.push(t);
    });
  }

  const excludeNames: string[] = [];
  if (!Array.isArray(input.excludeNames)) {
    errors.push("excludeNames must be an array");
  } else {
    if (input.excludeNames.length > PLAN_LIMITS.maxExcludeNames) {
      errors.push(`excludeNames must have at most ${PLAN_LIMITS.maxExcludeNames} items`);
    }
    input.excludeNames.forEach((n, i) => {
      const t = nonEmptyString(n, 160);
      if (!t) errors.push(`excludeNames[${i}] must be a non-empty string`);
      else excludeNames.push(t);
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  const plan: SearchPlan = {
    label: label!,
    months: months as number,
    signalQueries,
    signalSummaryQuery: signalSummaryQuery!,
    ...(followUp ? { followUp } : {}),
    companySummaryQuery: companySummaryQuery!,
    gateFields,
    employeeRange: employeeRange!,
    hqCountries,
    excludeDomains,
    excludeNames,
    signalTypes,
  };
  return { ok: true, plan };
}

/** Signal types a model may emit: plan.signalTypes plus the catch-all. */
export function signalTypeEnum(plan: Pick<SearchPlan, "signalTypes">): string[] {
  return [...plan.signalTypes, OTHER_SIGNAL_TYPE];
}

export function buildSignalSchema(plan: Pick<SearchPlan, "signalTypes">) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      company_name: { type: "string" },
      signal_type: { type: "string", enum: signalTypeEnum(plan) },
      signal_summary: { type: "string" },
      signal_date: { type: "string" },
      signal_quote: { type: "string" },
      signal_date_quote: { type: "string" },
    },
    required: ["company_name", "signal_type", "signal_summary", "signal_date", "signal_quote", "signal_date_quote"],
  } as const;
}

export function buildCompanySchema(plan: Pick<SearchPlan, "gateFields">) {
  const properties: Record<string, unknown> = {
    description: { type: "string" },
    industry: { type: "string" },
    employee_estimate: { anyOf: [{ type: "number" }, { type: "string" }] },
    employee_estimate_source: { type: "string" },
    is_public_or_enterprise: { type: "boolean" },
    hq: { type: "string" },
    hq_quote: { type: "string" },
  };
  const required: string[] = [...CORE_COMPANY_KEYS, "hq_quote"];
  for (const gate of plan.gateFields) {
    properties[gate.key] = { anyOf: [{ type: "boolean" }, { type: "null" }] };
    properties[`${gate.key}_quote`] = { type: "string" };
    required.push(gate.key, `${gate.key}_quote`);
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}

/** The signal summary query actually sent to Exa: plan text + format rules. */
export function composeSignalSummaryQuery(
  plan: Pick<SearchPlan, "signalTypes">,
  query: string,
): string {
  return (
    `${query} ` +
    `Set signal_date to the date the EVENT itself happened or was announced (not the article's publish date), ` +
    `in ISO format YYYY-MM-DD. ` +
    `Set signal_type to exactly one of: ${signalTypeEnum(plan).join(", ")}. ` +
    `For signal_quote, copy the exact sentence from the page that states the event; use "" if no sentence states an event. ` +
    `For signal_date_quote, copy the exact date phrase from the page; use "" if no date phrase is stated.`
  );
}

/** The company summary query actually sent to Exa: plan text + gate questions. */
export function composeCompanySummaryQuery(
  plan: Pick<SearchPlan, "companySummaryQuery" | "gateFields">,
): string {
  const source =
    " For employee_estimate_source, quote the exact phrase from the page that the employee estimate came from " +
    '(e.g. "350 employees"), or an empty string if no page states a headcount.' +
    " For hq_quote, quote the exact phrase from the page that states the headquarters/location, or an empty string if not stated.";
  if (plan.gateFields.length === 0) return `${plan.companySummaryQuery}${source}`;
  const gates = plan.gateFields
    .map((g) => `${g.key} (true/false/null): ${g.question} ${g.key}_quote: copy the exact phrase or sentence from the page that supports the answer; use "" when the page does not state it.`)
    .join(" ");
  return `${plan.companySummaryQuery}${source} Answer each gate as true only when the page states it, false only when the page contradicts it, and null when not stated. ${gates}`;
}

// ---------------------------------------------------------------------------
// Normalisers (T0 probe: Exa returned the literal string "null" and items with
// leading whitespace; signal_date came back in several formats).
// ---------------------------------------------------------------------------

const NULLISH_STRINGS = new Set(["", "null", "none", "n/a", "na", "undefined"]);

/**
 * Strings are trimmed; nullish-looking strings become undefined. Arrays have
 * each item normalised and nullish items dropped. Other values pass through.
 */
export function normalizeNullish<T>(v: T): T | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") {
    const t = v.trim();
    return (NULLISH_STRINGS.has(t.toLowerCase()) ? undefined : t) as T | undefined;
  }
  if (Array.isArray(v)) {
    return v
      .map((item) => normalizeNullish(item))
      .filter((item) => item !== undefined) as unknown as T;
  }
  return v;
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function monthIndex(name: string): number | undefined {
  const n = name.toLowerCase().replace(/\.$/, "");
  if (n.length < 3) return undefined;
  const idx = MONTHS.findIndex((m) => m === n || (n.length >= 3 && m.startsWith(n) && n.length <= m.length));
  if (idx >= 0) return idx;
  if (n === "sept") return 8;
  return undefined;
}

function isoFromParts(y: number, m: number, d: number): string | undefined {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return undefined;
  }
  return dt.toISOString().slice(0, 10);
}

/**
 * Parse the EVENT date out of a model-produced string into ISO YYYY-MM-DD.
 * Handles "2026-04-15", ISO datetimes, "Oct 1, 2026", "October 1st, 2026",
 * "1 October 2026", "2026/04/15". Month-only or ambiguous input -> undefined.
 * Parsed from the written parts (no timezone conversion).
 */
export function normalizeSignalDate(s: unknown): string | undefined {
  if (typeof s !== "string") return undefined;
  const t = normalizeNullish(s);
  if (!t) return undefined;

  let m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:$|[T\s])/);
  if (m) return isoFromParts(Number(m[1]), Number(m[2]), Number(m[3]));

  // "Oct 1, 2026" / "October 1st, 2026" / "Wed, Oct 1, 2026"
  m = t.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
  if (m) {
    const mi = monthIndex(m[1]!);
    if (mi !== undefined) return isoFromParts(Number(m[3]), mi + 1, Number(m[2]));
  }

  // "1 October 2026" / "1st of October, 2026"
  m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/);
  if (m) {
    const mi = monthIndex(m[2]!);
    if (mi !== undefined) return isoFromParts(Number(m[3]), mi + 1, Number(m[1]));
  }

  return undefined;
}
