import type { checkLead } from "../gates";

/**
 * The lead gate the loop calls for every submit_lead. Typed from the real
 * implementation in src/gates.ts so the workflow and the agent share one
 * definition of "what counts as a lead"; tests inject a fake.
 */
export type LeadChecker = typeof checkLead;

export const notWired: LeadChecker = () => {
  throw new Error("LeadChecker not wired");
};
