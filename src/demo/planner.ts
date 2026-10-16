import { validatePlan, type SearchPlan } from "../plan";
import type { CardSet } from "../planner";
import { readDemoJson } from "./mode";

/**
 * Demo stand-in for compilePlan: the model-written fields (queries, yes/no
 * questions, summary prompts) come from the recorded plan; every field the
 * real compiler copies from the cards is copied from the user's cards, so card
 * edits still show up in the contract.
 */
export async function demoPlan(cards: CardSet): Promise<{ plan: SearchPlan; cost: number; estimatedRunCost: number }> {
  const recorded = await readDemoJson<{ plan: SearchPlan; cost: number; estimatedRunCost: number }>("planner", "plan.json");
  const candidate: SearchPlan = {
    ...recorded.plan,
    label: `${cards.who.descriptor} with ${cards.whyNow.description}`.slice(0, 160),
    months: cards.recency.months,
    employeeRange: cards.size,
    hqCountries: cards.geo.hqCountries,
    excludeDomains: cards.exclusions.domains,
    excludeNames: cards.exclusions.names,
    signalTypes: cards.whyNow.signalTypes,
    ...(cards.buyerRoles && cards.buyerRoles.length > 0 ? { buyerRoles: cards.buyerRoles } : { buyerRoles: undefined }),
  };
  const valid = validatePlan(candidate);
  if (!valid.ok) throw new Error(`demo plan invalid: ${valid.errors.join("; ")}`);
  return { plan: valid.plan, cost: recorded.cost, estimatedRunCost: recorded.estimatedRunCost };
}
