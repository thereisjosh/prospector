/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { CANDIDATES_HEADING, CANDIDATES_INTRO, candidateReason, host, isHttpUrl } from "./copy";
import { ArrowUpRight } from "./parts";
import type { UnverifiedCandidate } from "./types";

/** Companies the agent found but could not verify. Renders nothing when there are none. Never counted as leads. */
export function Candidates({ candidates }: { candidates: UnverifiedCandidate[] }) {
  if (candidates.length === 0) return null;
  return (
    <section className="candidates" aria-labelledby="candidates-h">
      <div className="section-head">
        <h2 id="candidates-h">
          {CANDIDATES_HEADING} <span className="count">{candidates.length}</span>
        </h2>
      </div>
      <p className="muted small candidates-intro">{CANDIDATES_INTRO}</p>
      <ul className="cand-rows">
        {candidates.map((c) => (
          <li key={c.company} className="cand-row">
            <div className="cand-main">
              <div className="company-name">{c.company}</div>
              <div className="cand-why">{c.why_now}</div>
              <div className="muted small cand-reason">{candidateReason(c.missing)}</div>
            </div>
            <div className="cand-source">
              {isHttpUrl(c.signal_url) ? (
                <a href={c.signal_url} target="_blank" rel="noopener noreferrer">
                  <span>{host(c.signal_url)}</span> <ArrowUpRight />
                </a>
              ) : (
                <span className="no-source">No safe link</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
