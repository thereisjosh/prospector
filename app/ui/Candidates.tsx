/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceLine, TraceTitle } from "@/components/ui/trace";
import { CANDIDATES_HEADING, CANDIDATES_INTRO, type ContractView } from "./copy";
import { ArrowUpRight } from "./parts";
import { LineIcon } from "./RunTrace";
import { candidatesModel } from "./trace-model";
import type { UnverifiedCandidate } from "./types";

/**
 * Companies the agent found but could not verify. Renders nothing when there are none. Never counted as leads.
 * Sectioned Trace, not Queue (docs/UI-REWORK.md §0): nothing will ever verify them later, so no "to do" wording.
 */
export function Candidates({ candidates, contract }: { candidates: UnverifiedCandidate[]; contract?: ContractView }) {
  if (candidates.length === 0) return null;
  const sections = candidatesModel({ candidates, contract: contract as ContractView });
  return (
    <section className="candidates" aria-labelledby="candidates-h">
      <div className="section-head">
        <h2 id="candidates-h">
          {CANDIDATES_HEADING} <span className="count">{candidates.length}</span>
        </h2>
      </div>
      <p className="muted small candidates-intro">{CANDIDATES_INTRO}</p>
      <div className="pr-sections">
        {sections.map((section) => (
          <div key={section.id} className="pr-section">
            <h3 className="pr-section-label">
              {section.label} <span className="count">{section.count}</span>
            </h3>
            <Trace className="gap-1.5">
              {section.items.map((c) => (
                // keepMounted: the reason and source stay in the document (find-in-page, SSR), hidden until opened.
                <TraceCollapsible key={c.company}>
                  <TraceCollapsibleTrigger className="pr-press">
                    <TraceLine className="pr-trace-line">
                      <LineIcon name="note" />
                      <TraceTitle className="pr-trace-title font-medium text-foreground">{c.company}</TraceTitle>
                      {c.sourceHost && <TraceDescription className="pr-trace-desc">{c.sourceHost}</TraceDescription>}
                    </TraceLine>
                  </TraceCollapsibleTrigger>
                  <TraceCollapsibleContent keepMounted>
                    <div className="cand-detail">
                      <p className="cand-why">{c.whyNow}</p>
                      <p className="muted small cand-reason">{c.reason}</p>
                      <p className="cand-source">
                        {c.sourceUrl ? (
                          <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer">
                            <span>{c.sourceHost}</span> <ArrowUpRight />
                          </a>
                        ) : (
                          <span className="no-source">No safe link</span>
                        )}
                      </p>
                    </div>
                  </TraceCollapsibleContent>
                </TraceCollapsible>
              ))}
            </Trace>
          </div>
        ))}
      </div>
    </section>
  );
}
