import { ICP_1 } from "./config";
import type { IcpConfig } from "./types";

export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function dateInWindow(
  value: string,
  startIso: string,
  now = new Date(),
): boolean {
  const date = new Date(value);
  const start = new Date(startIso);
  return Number.isFinite(date.getTime()) && date >= start && date <= now;
}

export function nameMatchesSignal(args: {
  company: string;
  title?: string;
  text?: string;
  summary?: string;
}): boolean {
  const company = normalizeName(args.company);
  if (!company) return false;
  const haystack = normalizeName(
    [args.title, args.text, args.summary].filter(Boolean).join(" "),
  );
  return haystack.includes(company);
}

export function netNew(company: string, baseline = ICP_1.baseline): boolean {
  const normalized = normalizeName(company);
  return !baseline.some((name) => normalizeName(name) === normalized);
}

export function companyFitChecks(args: {
  icp?: IcpConfig;
  company: string;
  description?: string;
  industry?: string;
  employeeEstimate?: number;
  isThirdPartyLogistics?: boolean;
}): { size_in_range: boolean; is_3pl: boolean } {
  const text = normalizeName(
    [args.description, args.industry, args.company].filter(Boolean).join(" "),
  );
  const logisticsTerms = [
    "3pl",
    "third party logistics",
    "logistics",
    "logistics provider",
    "contract logistics",
    "freight",
    "freight forwarding",
    "freight brokerage",
    "fulfillment",
    "fulfillment services",
    "warehouse",
    "warehousing",
    "last mile",
    "final mile",
    "transportation",
    "supply chain",
    "supply chain solutions",
  ];
  const nonOperatorTerms = [
    "consumer brand",
    "retail brand",
    "retailer",
    "beverage",
    "pharmaceutical",
    "pharmacy",
    "healthcare",
    "chemical",
    "manufacturer",
    "real estate",
    "property",
    "grocery",
    "marketplace",
    "robotics",
    "software",
    "automation",
  ];
  const is3pl =
    args.isThirdPartyLogistics === true ||
    (logisticsTerms.some((term) => text.includes(normalizeName(term))) &&
      !nonOperatorTerms.some((term) => text.includes(normalizeName(term))));
  const range = args.icp?.employeeRange ?? { min: 75, max: 1500 };
  const sizeInRange =
    args.employeeEstimate === undefined ||
    (args.employeeEstimate >= range.min && args.employeeEstimate <= range.max);

  return {
    size_in_range: sizeInRange,
    is_3pl: is3pl,
  };
}

export async function urlResolves(url: string): Promise<boolean> {
  try {
    const head = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (head.ok) return true;
    const get = await fetch(url, { method: "GET", redirect: "follow" });
    return get.ok;
  } catch {
    return false;
  }
}
