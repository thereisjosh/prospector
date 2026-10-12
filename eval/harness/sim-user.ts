import { pathToFileURL } from "node:url";
import type { Scenario, RunRecord } from "./types";

function cloneScenario(scenario: Scenario): Scenario {
  return JSON.parse(JSON.stringify(scenario)) as Scenario;
}

export function applyFirstHandbackSuggestion(scenario: Scenario, record: RunRecord): Scenario {
  const suggestion = record.handback?.suggestions[0];
  const next = cloneScenario(scenario);
  if (!suggestion) return next;
  if (suggestion.field === "employeeRange" && suggestion.value && typeof suggestion.value === "object") {
    const value = suggestion.value as { min?: unknown; max?: unknown };
    if (typeof value.min === "number" && typeof value.max === "number") {
      next.plan.employeeRange = { ...next.plan.employeeRange, min: value.min, max: value.max };
    }
  } else if (suggestion.field === "months" && typeof suggestion.value === "number") {
    next.plan.months = suggestion.value;
  } else if (suggestion.field === "hqCountries") {
    if (suggestion.value === "any") next.plan.hqCountries = [];
    else if (Array.isArray(suggestion.value)) next.plan.hqCountries = suggestion.value.filter((c): c is string => typeof c === "string");
  }
  return next;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) out[arg.slice(2)] = argv[++i] ?? "";
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.help) {
    console.log("sim-user is used by run-cell --handback; it applies handback suggestion #1 deterministically.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
