import { countryCodeFromName } from "../geo";
import { isRecord } from "./claude";

/**
 * Shape-tolerant normalisation of model output. Runs BEFORE validation so that
 * harmless shape variation (objects vs strings, comma strings vs arrays,
 * "6 months" vs 6) is repaired instead of rejected. Pure; never throws.
 */

const LABEL_KEYS = ["type", "name", "label", "id", "value", "query", "text", "q"];

/** array of strings | array of objects | single comma/newline-separated string -> string[] */
export function toStringList(value: unknown, keys: string[] = LABEL_KEYS, splitOnComma = true): string[] {
  let items: unknown[];
  if (Array.isArray(value)) items = value;
  else if (typeof value === "string") items = value.split(splitOnComma ? /[\n,;]+/ : /\n+/);
  else return [];
  const out: string[] = [];
  for (const item of items) {
    let s: string | undefined;
    if (typeof item === "string") s = item;
    else if (isRecord(item)) {
      for (const k of keys) {
        const v = item[k];
        if (typeof v === "string" && v.trim()) {
          s = v;
          break;
        }
      }
    }
    if (s && s.trim()) out.push(s.trim());
  }
  return out;
}

export function snakeCase(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

export function toNumber(value: unknown): unknown {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;
  const cleaned = value.replace(/,/g, "").trim().toLowerCase();
  const m = cleaned.match(/^-?\d+(\.\d+)?/);
  if (!m) return value;
  const n = Number(m[0]);
  return /^\s*k\b/.test(cleaned.slice(m[0].length)) ? n * 1000 : n;
}

export function toMonths(value: unknown): unknown {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;
  const m = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(year|yr|y)?/);
  if (!m) return value;
  const n = Number(m[1]);
  return m[2] ? n * 12 : n;
}

function toBool(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const v = value.trim().toLowerCase();
  if (["yes", "true", "y", "1", "required"].includes(v)) return true;
  if (["no", "false", "n", "0", "optional"].includes(v)) return false;
  return value;
}

export function coerceCardSet(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const out: Record<string, unknown> = { ...raw };

  if (typeof raw.who === "string" && raw.who.trim()) out.who = { industry: raw.who.trim(), descriptor: raw.who.trim() };

  if (isRecord(raw.whyNow)) {
    const signalTypes = toStringList(raw.whyNow.signalTypes)
      .map(snakeCase)
      .filter((s) => s.length >= 2);
    out.whyNow = { ...raw.whyNow, signalTypes: [...new Set(signalTypes)].slice(0, 6) };
  }

  if (isRecord(raw.size)) {
    const policy = typeof raw.size.unknownPolicy === "string"
      ? raw.size.unknownPolicy.trim().toLowerCase().replace(/[\s_]+/g, "-")
      : raw.size.unknownPolicy;
    out.size = { ...raw.size, min: toNumber(raw.size.min), max: toNumber(raw.size.max), unknownPolicy: policy };
  }

  if (isRecord(raw.geo)) {
    const countries = toStringList(raw.geo.hqCountries, ["code", "iso2", "iso", "country", "name", "label", "id", "value"])
      .map((c) => countryCodeFromName(c) ?? c.toUpperCase());
    out.geo = { ...raw.geo, hqCountries: [...new Set(countries)] };
  }

  if (isRecord(raw.recency)) out.recency = { ...raw.recency, months: toMonths(raw.recency.months) };
  else if (raw.recency !== undefined) out.recency = { months: toMonths(raw.recency) };

  const ex = isRecord(raw.exclusions) ? raw.exclusions : {};
  out.exclusions = { names: toStringList(ex.names), domains: toStringList(ex.domains) };

  out.rationale = isRecord(raw.rationale) ? raw.rationale : {};
  out.alternatives = Array.isArray(raw.alternatives) ? raw.alternatives.slice(0, 2) : [];
  return out;
}

export function coercePlanOutput(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const out: Record<string, unknown> = { ...raw };
  out.signalQueries = toStringList(raw.signalQueries, ["query", "text", "q", "name", "label", "value"], false);
  if (Array.isArray(raw.gateFields)) {
    out.gateFields = raw.gateFields.map((gate) => {
      if (!isRecord(gate)) return gate;
      return {
        ...gate,
        key: typeof gate.key === "string" ? snakeCase(gate.key) : gate.key,
        required: toBool(gate.required),
      };
    });
  }
  return out;
}
