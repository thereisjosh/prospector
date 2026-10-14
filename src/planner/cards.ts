import { resolvePrompt, type PromptConfig, type PromptDef } from "../agent/prompt-store";
import { callClaudeJson, cleanString, formatSection, isRecord, type PlannerModelDeps } from "./claude";
import { coerceCardSet } from "./coerce";
import type { SellerProfile } from "./profile";

// <langfuse-prompt name="prospector-planner-cards"> repo copy and runtime fallback; sync with `npx tsx eval/langfuse-prompts.ts push|pull|diff` (docs/prompts.md)
export const CARDS_SYSTEM_PROMPT = `You suggest lead-search cards for a B2B prospecting tool.
Reply with ONE JSON object and nothing else.
Cards: who describes target industry and company descriptor; whyNow lists ordered snake_case signal types and a human description; size is employee range and unknown-size policy; stage is optional and must be exactly one of any | seed | series_a | series_b_plus | bootstrapped (use any when funding stage does not matter for this buyer); geo is HQ ISO-2 countries; recency is months; exclusions are customer/competitor names and domains.
Exa levers: recency is a hard startPublishedDate filter; size, geo, and stage are estimated from retrieved company evidence; signal types become search and summary prompts.
Output must be realistic for a B2B seller of this offering.
Reply with one JSON object with exactly these keys; arrays of plain strings where shown; no markdown fences.
Enums: stage is one of any | seed | series_a | series_b_plus | bootstrapped; size.unknownPolicy is one of allow-if-not-enterprise | reject; geo.hqCountries are uppercase ISO-2 codes; whyNow.signalTypes is 2-6 snake_case strings (plain strings, not objects); size.min and size.max and recency.months are integers (months 1-12); alternatives is an array of at most 2 items (use [] if none).
EXAMPLE (shape and enum values only; use values that fit this seller):
{
  "who": {
    "industry": "independent restaurants and cafes",
    "descriptor": "owner-operated cafes with 1-5 outlets"
  },
  "whyNow": {
    "signalTypes": [
      "new_location",
      "hiring_ops",
      "menu_relaunch"
    ],
    "description": "opening outlets or changing operations in a way that creates a need for new payment hardware"
  },
  "size": {
    "min": 5,
    "max": 200,
    "unknownPolicy": "allow-if-not-enterprise"
  },
  "stage": "any",
  "geo": {
    "hqCountries": [
      "SG",
      "MY"
    ]
  },
  "recency": {
    "months": 6
  },
  "exclusions": {
    "names": [
      "Starbucks"
    ],
    "domains": [
      "starbucks.com"
    ]
  },
  "rationale": {
    "who": "why this buyer fits the offering",
    "whyNow": "why these signals mean they are buying now",
    "size": "why this employee range",
    "geo": "why these countries"
  },
  "alternatives": []
}`;
export const CARDS_PROMPT_CONFIG: PromptConfig = {"model":"claude-opus-5-5","effort":"medium","max_tokens":4000};
// </langfuse-prompt>

export const CARDS_PROMPT_DEF: PromptDef = {
  name: "prospector-planner-cards",
  text: CARDS_SYSTEM_PROMPT,
  config: CARDS_PROMPT_CONFIG,
  repoVersionId: "prospector-planner-cards@repo",
};

/** The format section the retry message repeats (also inside the system prompt). */
export const CARDS_FORMAT_INSTRUCTIONS = formatSection(CARDS_SYSTEM_PROMPT)!;

export type CardSet = {
  who: { industry: string; descriptor: string };
  whyNow: { signalTypes: string[]; description: string };
  size: { min: number; max: number; unknownPolicy: "allow-if-not-enterprise" | "reject" };
  stage?: "any" | "seed" | "series_a" | "series_b_plus" | "bootstrapped";
  geo: { hqCountries: string[] };
  recency: { months: number };
  exclusions: { names: string[]; domains: string[] };
  rationale: Record<string, string>;
  alternatives: { label: string; cards: Partial<CardSet> }[];
};

export async function suggestCards(profile: SellerProfile, deps: PlannerModelDeps): Promise<{ cards: CardSet; cost: number }> {
  const prompt = await resolvePrompt(CARDS_PROMPT_DEF);
  const { value, cost } = await callClaudeJson(deps, prompt, JSON.stringify(profile), validateCards);
  return { cards: value, cost };
}

export function validateCards(raw: unknown) {
  const errors: string[] = [];
  const input = coerceCardSet(raw);
  if (!isRecord(input)) return { ok: false as const, errors: ["cards must be an object"] };
  const who = object(input.who, "who", errors);
  const whyNow = object(input.whyNow, "whyNow", errors);
  const size = object(input.size, "size", errors);
  const geo = object(input.geo, "geo", errors);
  const recency = object(input.recency, "recency", errors);
  const exclusions = object(input.exclusions, "exclusions", errors);
  const rationale = object(input.rationale, "rationale", errors);

  // stage is optional and advisory: an unknown value (e.g. "growth", "established")
  // is coerced to "any" rather than failing the whole card set.
  const STAGES = ["any", "seed", "series_a", "series_b_plus", "bootstrapped"];
  const rawStage = input.stage === undefined || input.stage === null ? undefined : String(input.stage).toLowerCase().replace(/[\s-]+/g, "_");
  const stage = rawStage === undefined ? undefined : STAGES.includes(rawStage) ? rawStage : "any";

  // Model output is normalised, not rejected, where the intent is unambiguous:
  // "New facility" / "new-facility" → "new_facility"; a missing descriptor falls back to the industry.
  const signalTypes = stringArray(whyNow?.signalTypes, "whyNow.signalTypes", errors)
    .map((s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40))
    .filter((s) => s.length >= 2);
  if (who && typeof who === "object" && !cleanString((who as { descriptor?: unknown }).descriptor) && cleanString((who as { industry?: unknown }).industry)) {
    (who as { descriptor?: unknown }).descriptor = (who as { industry?: unknown }).industry;
  }
  if (!cleanString(who?.industry)) errors.push("who.industry must be a non-empty string");
  if (!cleanString(who?.descriptor)) errors.push("who.descriptor must be a non-empty string");
  if (!cleanString(whyNow?.description)) errors.push("whyNow.description must be a non-empty string");
  if (signalTypes.length < 2 || signalTypes.length > 6) errors.push("whyNow.signalTypes must have 2-6 items");
  signalTypes.forEach((s, i) => {
    if (!/^[a-z0-9][a-z0-9_]{1,40}$/.test(s)) errors.push(`whyNow.signalTypes[${i}] must be snake_case`);
  });

  const min = numberField(size?.min, "size.min", errors);
  const max = numberField(size?.max, "size.max", errors);
  if (min !== undefined && max !== undefined && min > max) errors.push("size.min must be <= size.max");
  if (size?.unknownPolicy !== "allow-if-not-enterprise" && size?.unknownPolicy !== "reject") {
    errors.push("size.unknownPolicy must be allow-if-not-enterprise or reject");
  }

  const countries = stringArray(geo?.hqCountries, "geo.hqCountries", errors);
  countries.forEach((c, i) => {
    if (!/^[A-Z]{2}$/.test(c)) errors.push(`geo.hqCountries[${i}] must be uppercase ISO-2`);
  });
  const months = numberField(recency?.months, "recency.months", errors);
  if (months !== undefined && (!Number.isInteger(months) || months < 1 || months > 12)) {
    errors.push("recency.months must be an integer 1-12");
  }

  const alternatives = Array.isArray(input.alternatives) ? input.alternatives : [];
  if (!Array.isArray(input.alternatives)) errors.push("alternatives must be an array");
  if (alternatives.length > 2) errors.push("alternatives must have max 2 items");

  if (errors.length) return { ok: false as const, errors };
  const cards: CardSet = {
    who: { industry: cleanString(who!.industry)!, descriptor: cleanString(who!.descriptor)! },
    whyNow: { signalTypes, description: cleanString(whyNow!.description)! },
    size: { min: min!, max: max!, unknownPolicy: size!.unknownPolicy as CardSet["size"]["unknownPolicy"] },
    ...(stage ? { stage: stage as CardSet["stage"] } : {}),
    geo: { hqCountries: [...new Set(countries)] },
    recency: { months: months! },
    exclusions: {
      names: stringArray(exclusions!.names, "exclusions.names", []),
      domains: stringArray(exclusions!.domains, "exclusions.domains", []),
    },
    rationale: Object.fromEntries(Object.entries(rationale!).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, (v as string).trim()])),
    alternatives: alternatives.map((alt) => ({
      label: isRecord(alt) ? cleanString(alt.label) ?? "Alternative" : "Alternative",
      cards: isRecord(alt) && isRecord(alt.cards) ? alt.cards as Partial<CardSet> : {},
    })),
  };
  return { ok: true as const, value: cards };
}

function object(value: unknown, path: string, errors: string[]): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return undefined;
  }
  return value;
}

function numberField(value: unknown, path: string, errors: string[]): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${path} must be a number`);
    return undefined;
  }
  return value;
}

function stringArray(value: unknown, path: string, errors: string[]): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}
