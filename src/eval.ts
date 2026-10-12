import { ENTERPRISE_DENYLIST } from "./config";
import type { SearchPlan } from "./plan";

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

export function netNew(
  company: string,
  baseline: readonly string[] = ENTERPRISE_DENYLIST,
): boolean {
  const normalized = normalizeName(company);
  return !baseline.some((name) => normalizeName(name) === normalized);
}

/**
 * Best-effort ICP fit from company firmographics, driven entirely by the plan:
 * employee estimate vs plan.employeeRange, and every `required` gate true.
 */
export function companyFitChecks(args: {
  plan: Pick<SearchPlan, "employeeRange" | "gateFields">;
  employeeEstimate?: number;
  gates: Record<string, unknown>;
}): { size_in_range: boolean; required_gates_pass: boolean } {
  const { min, max } = args.plan.employeeRange;
  const sizeInRange =
    args.employeeEstimate === undefined ||
    (args.employeeEstimate >= min && args.employeeEstimate <= max);
  const requiredGatesPass = args.plan.gateFields
    .filter((gate) => gate.required)
    .every((gate) => args.gates[gate.key] === true);
  return { size_in_range: sizeInRange, required_gates_pass: requiredGatesPass };
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
