import "dotenv/config";
import type { ExaSearchType } from "./types";

export const VALID_SEARCH_TYPES = new Set<ExaSearchType>([
  "auto",
  "keyword",
  "neural",
  "fast",
  "deep",
]);

export const ENTERPRISE_DENYLIST: readonly string[] = [
  "RXO",
  "XPO",
  "XPO Logistics",
  "GXO",
  "GXO Logistics",
  "C.H. Robinson",
  "J.B. Hunt",
  "DHL",
  "DHL Supply Chain",
  "FedEx",
  "FedEx Logistics",
  "UPS",
  "UPS Supply Chain Solutions",
  "Walmart",
  "ADP",
  "DSV",
  "Kuehne+Nagel",
  "Kuehne + Nagel",
  "DB Schenker",
  "Ryder",
  "Ryder System",
  "Expeditors",
  "Flexport",
  "Uber Freight",
  "Penske",
  "Penske Logistics",
  "GEODIS",
] as const;

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.replace(/\/$/, "");
}

export function parseSearchType(value: string | undefined): ExaSearchType {
  const searchType = (value ?? "neural") as ExaSearchType;
  if (!VALID_SEARCH_TYPES.has(searchType)) {
    throw new Error(
      `Invalid Exa search type "${searchType}". Expected one of: ${[
        ...VALID_SEARCH_TYPES,
      ].join(", ")}`,
    );
  }
  return searchType;
}

export function monthsAgoIso(months: number, now = new Date()): string {
  const date = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString();
}
