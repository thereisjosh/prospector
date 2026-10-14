"use client";

import { useId, useState } from "react";
import type { AcceptedLead, Handback } from "../../src/agent/state";
import type { CardSet } from "../../src/planner/cards";
import { CountryPicker } from "./CardsStep";
import { Candidates } from "./Candidates";
import {
  UNVERIFIED_SUFFIX,
  describeChange,
  formatDate,
  groupRejections,
  host,
  isHttpUrl,
  leadDate,
  leadFit,
  leadSize,
  leadsCsv,
  money,
  plainText,
  readScopeChange,
  reasonGroup,
  shortfallHeadline,
  stopSentence,
  suggestionPatch,
  suggestionTitle,
  isChangeField,
  droppedAfterLookup,
  type Screened,
  type ContractView,
  type FeedLine,
  type SuggestionPatch,
} from "./copy";
import { AlertIcon, ArrowUpRight, Checklist, Download, Spinner, ThumbDown, ThumbUp } from "./parts";
import type { Feedback, RunSnapshot } from "./types";

export type FeedItem = FeedLine & { id: number };

export type Decision = { approve: boolean; note?: string; revisedValue?: unknown };

type Props = {
  demo: boolean;
  snapshot: RunSnapshot | null;
  feed: FeedItem[];
  screened: Screened;
  stepping: boolean;
  pausedByUser: boolean;
  runError: string;
  deciding: boolean;
  decisionError: string;
  onStop: () => void;
  onResume: () => void;
  onDecide: (decision: Decision) => void;
  feedback: Record<string, Feedback>;
  onFeedback: (company: string, next: Feedback, send: boolean) => void;
  cards: CardSet | null;
  maxSpend: number;
  onApply: (patch: SuggestionPatch) => void;
  applying: boolean;
  onEditTargeting: () => void;
  onNewSearch: () => void;
};

export function RunView(props: Props) {
  const { snapshot, feed, stepping, pausedByUser, runError } = props;

  if (!snapshot) {
    return (
      <div className="state" aria-live="polite">
        {runError ? (
          <>
            <AlertIcon />
            <p>{runError}</p>
            <button type="button" className="ghost-btn" onClick={props.onResume}>Try again</button>
          </>
        ) : (
          <>
            <Spinner />
            <p>Starting the agent…</p>
          </>
        )}
      </div>
    );
  }

  const { status, contract } = snapshot;
  const finished = status === "done" || status === "stopped" || status === "error";
  const waiting = status === "awaiting_approval" && !!snapshot.pendingApproval;

  return (
    <div className="step run">
      <StatusBar {...props} snapshot={snapshot} finished={finished} waiting={waiting} />

      {waiting && snapshot.pendingApproval && (
        <ApprovalCard
          demo={props.demo}
          pending={snapshot.pendingApproval}
          contract={contract}
          deciding={props.deciding}
          error={props.decisionError}
          onDecide={props.onDecide}
        />
      )}

      {finished && (
        <Outcome
          snapshot={snapshot}
          cards={props.cards}
          maxSpend={props.maxSpend}
          onApply={props.onApply}
          applying={props.applying}
          onEditTargeting={props.onEditTargeting}
          onNewSearch={props.onNewSearch}
        />
      )}

      <div className="run-grid">
        <section className="panel" aria-labelledby="todo-h">
          <h2 id="todo-h" className="panel-title">{finished ? "The agent's last checklist update" : "The agent's checklist"}</h2>
          {snapshot.todo.trim() ? (
            <Checklist markdown={snapshot.todo} />
          ) : (
            <p className="muted">{finished ? "No checklist was written." : "The agent writes its checklist once you approve its opening plan."}</p>
          )}
        </section>

        <aside className="panel" aria-labelledby="spend-h">
          <h2 id="spend-h" className="panel-title">Spend</h2>
          <SpendMeter spend={snapshot.spend} cap={contract.maxCostDollars} />
          <dl className="mini-stats">
            <div>
              <dt>Leads</dt>
              <dd>
                {snapshot.leads.length} <span className="muted">of {contract.targetLeads}</span>
              </dd>
            </div>
            <div>
              <dt>Turned down</dt>
              <dd>{snapshot.rejected.length}</dd>
            </div>
          </dl>
        </aside>

        <section className="panel feed-panel" aria-labelledby="feed-h">
          <h2 id="feed-h" className="panel-title">What it's doing</h2>
          {feed.length === 0 ? (
            <p className="muted">{stepping ? "Reading your plan…" : "Nothing yet."}</p>
          ) : (
            <ol className="feed" aria-live="polite" aria-relevant="additions">
              {[...feed].reverse().map((item) => (
                <li key={item.id} className={`feed-item tone-${item.tone}`}>
                  <span className="feed-dot" aria-hidden="true" />
                  <span>{item.text}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <Leads
        leads={snapshot.leads}
        finished={finished || pausedByUser}
        live={!finished && !pausedByUser}
        feedback={props.feedback}
        onFeedback={props.onFeedback}
      />

      <Candidates candidates={snapshot.candidates ?? []} />

      <Rejections
        rejected={snapshot.rejected}
        screenedGroups={snapshot.screened}
        contract={contract}
        finished={finished}
        dropped={
          // Recordings with lookup-stage screening say why each lookup failed; older ones don't.
          snapshot.screened
            ? []
            : droppedAfterLookup(props.screened, [...snapshot.leads.map((l) => l.company), ...snapshot.rejected.map((r) => r.company)])
        }
        skipped={droppedAfterLookup(
          { lookedUp: props.screened.skipped, skipped: [] },
          [...props.screened.lookedUp, ...snapshot.leads.map((l) => l.company), ...snapshot.rejected.map((r) => r.company)],
        )}
      />
    </div>
  );
}

/* ---------- status ---------- */

function StatusBar(props: Props & { snapshot: RunSnapshot; finished: boolean; waiting: boolean }) {
  const { snapshot, finished, waiting, stepping, pausedByUser, runError } = props;
  let tone = "is-live";
  let text = `Working${snapshot.counters?.turns ? `, step ${snapshot.counters.turns}` : ""}…`;
  if (waiting) {
    tone = "is-wait";
    text = "Waiting for your OK";
  } else if (finished) {
    tone = snapshot.status === "error" ? "is-bad" : "is-done";
    text = snapshot.status === "error" ? "The run hit a problem and stopped. Here's what it found first." : stopSentence(snapshot.stopReason, snapshot.status);
  } else if (runError) {
    tone = "is-bad";
    text = runError;
  } else if (pausedByUser && !stepping) {
    tone = "is-wait";
    text = "Paused by you. Results so far are below.";
  }
  return (
    <div className={`status-bar ${tone}`} role="status" aria-live="polite">
      <span className="status-dot" aria-hidden="true" />
      <span className="status-text">{text}</span>
      <span className="status-actions">
        {!finished && !waiting && !pausedByUser && !runError && (
          <button type="button" className="ghost-btn small" onClick={props.onStop}>Stop</button>
        )}
        {!finished && !waiting && (pausedByUser || runError) && !stepping && (
          <button type="button" className="ghost-btn small" onClick={props.onResume}>{runError ? "Try again" : "Keep going"}</button>
        )}
      </span>
    </div>
  );
}

function SpendMeter({ spend, cap }: { spend: RunSnapshot["spend"]; cap: number }) {
  // Total = the two rounded parts, so the three figures on screen always add up.
  const shownTotal = Math.round(spend.claude * 100) / 100 + Math.round(spend.exa * 100) / 100;
  const pct = (n: number) => `${Math.max(0, Math.min(100, (n / Math.max(cap, 0.01)) * 100))}%`;
  return (
    <div className="spend">
      <p className="spend-total">
        <b>{money(shownTotal)}</b> <span className="muted">of {money(cap)} limit</span>
      </p>
      <div
        className="spend-track"
        role="meter"
        aria-label="Money spent"
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={Number(spend.total.toFixed(2))}
        aria-valuetext={`${money(shownTotal)} of ${money(cap)}`}
      >
        <span className="spend-ai" style={{ width: pct(spend.claude) }} />
        <span className="spend-web" style={{ width: pct(spend.exa) }} />
      </div>
      <ul className="spend-legend">
        <li><span className="swatch swatch-ai" aria-hidden="true" />AI reasoning {money(spend.claude)}</li>
        <li><span className="swatch swatch-web" aria-hidden="true" />Web research {money(spend.exa)}</li>
      </ul>
    </div>
  );
}

/* ---------- approval ---------- */

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
}

function ApprovalCard({
  demo,
  pending,
  contract,
  deciding,
  error,
  onDecide,
}: {
  demo: boolean;
  pending: { tool: string; input: unknown };
  contract: ContractView;
  deciding: boolean;
  error: string;
  onDecide: (d: Decision) => void;
}) {
  const [editing, setEditing] = useState(false);
  const isStrategy = pending.tool === "propose_strategy";
  const input = (pending.input ?? {}) as Record<string, unknown>;
  const titleId = useId();

  return (
    <section className="approval" aria-labelledby={titleId}>
      <p className="eyebrow">Needs your OK</p>
      {isStrategy ? (
        <>
          <h2 id={titleId}>Here's how the agent plans to start</h2>
          {strings(input.angles).length > 0 && (
            <>
              <h3 className="sub">Angles</h3>
              <ul className="plain-list">{strings(input.angles).map((a) => <li key={a}>{a}</li>)}</ul>
            </>
          )}
          {strings(input.first_queries).length > 0 && (
            <>
              <h3 className="sub">First searches</h3>
              <ul className="plain-list quotes">{strings(input.first_queries).map((q) => <li key={q}>{q}</li>)}</ul>
            </>
          )}
          {typeof input.est_cost_dollars === "number" && (
            <p className="muted">
              Its estimate for the whole run: <b className="ink">{money(input.est_cost_dollars)}</b> (your limit is {money(contract.maxCostDollars)}).
            </p>
          )}
        </>
      ) : (
        <ScopeSummary input={pending.input} contract={contract} titleId={titleId} />
      )}

      {demo && <p className="demo-note">Demo: the recorded run continues the same way whichever you choose.</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}

      {editing ? (
        isStrategy ? (
          <StrategyEditor deciding={deciding} onCancel={() => setEditing(false)} onSubmit={(note) => onDecide({ approve: true, note, revisedValue: note })} />
        ) : (
          <ScopeEditor input={pending.input} contract={contract} deciding={deciding} onCancel={() => setEditing(false)} onSubmit={onDecide} />
        )
      ) : (
        <div className="actions">
          <button type="button" className="primary-btn" disabled={deciding} onClick={() => onDecide({ approve: true })}>
            {deciding ? "Sending…" : "Approve"}
          </button>
          <button type="button" className="ghost-btn" disabled={deciding} onClick={() => setEditing(true)}>Edit</button>
          <button type="button" className="ghost-btn danger" disabled={deciding} onClick={() => onDecide({ approve: false })}>Decline</button>
        </div>
      )}
    </section>
  );
}

function ScopeSummary({ input, contract, titleId }: { input: unknown; contract: ContractView; titleId: string }) {
  const change = readScopeChange(input);
  return (
    <>
      <h2 id={titleId}>The agent wants to change your targeting</h2>
      <p className="change-line">{describeChange(change.field, change.value, contract)}</p>
      {change.reason && (
        <p>
          <span className="muted">Why: </span>
          {change.reason}
        </p>
      )}
      {change.evidence && (
        <p>
          <span className="muted">Evidence: </span>
          {change.evidence}
        </p>
      )}
    </>
  );
}

function StrategyEditor({ deciding, onCancel, onSubmit }: { deciding: boolean; onCancel: () => void; onSubmit: (note: string) => void }) {
  const [note, setNote] = useState("");
  const id = useId();
  return (
    <div className="editor">
      <label htmlFor={id}>What should it do differently?</label>
      <textarea id={id} className="input" rows={3} value={note} placeholder="e.g. Skip hiring posts; focus on new warehouses." onChange={(e) => setNote(e.target.value)} />
      <div className="actions">
        <button type="button" className="primary-btn" disabled={deciding || !note.trim()} onClick={() => onSubmit(note.trim())}>
          Approve with this change
        </button>
        <button type="button" className="ghost-btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function ScopeEditor({
  input,
  contract,
  deciding,
  onCancel,
  onSubmit,
}: {
  input: unknown;
  contract: ContractView;
  deciding: boolean;
  onCancel: () => void;
  onSubmit: (d: Decision) => void;
}) {
  const change = readScopeChange(input);
  const proposed = (change.value ?? {}) as Record<string, unknown>;
  const [min, setMin] = useState(typeof proposed.min === "number" ? proposed.min : contract.employeeRange.min);
  const [max, setMax] = useState(typeof proposed.max === "number" ? proposed.max : contract.employeeRange.max);
  const [months, setMonths] = useState(typeof change.value === "number" ? change.value : contract.months);
  const [countries, setCountries] = useState<string[]>(Array.isArray(change.value) ? strings(change.value) : contract.hqCountries);
  const [industry, setIndustry] = useState(typeof change.value === "string" ? change.value : "");
  const [budget, setBudget] = useState(typeof change.value === "number" ? change.value : contract.maxCostDollars);
  const ids = { a: useId(), b: useId(), c: useId() };

  let value: unknown;
  let valid = true;
  let body: React.ReactNode = null;
  switch (change.field) {
    case "employeeRange":
      value = { min, max, unknownPolicy: proposed.unknownPolicy === "reject" ? "reject" : contract.employeeRange.unknownPolicy };
      valid = min >= 1 && max >= min;
      body = (
        <div className="pair">
          <div className="field">
            <label htmlFor={ids.a}>From (employees)</label>
            <input id={ids.a} className="input" type="number" min={1} value={min} onChange={(e) => setMin(Number(e.target.value))} />
          </div>
          <div className="field">
            <label htmlFor={ids.b}>To (employees)</label>
            <input id={ids.b} className="input" type="number" min={1} value={max} onChange={(e) => setMax(Number(e.target.value))} />
          </div>
        </div>
      );
      break;
    case "months":
      value = months;
      body = (
        <div className="field">
          <label htmlFor={ids.a}>Look back</label>
          <select id={ids.a} className="input" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{m} month{m === 1 ? "" : "s"}</option>)}
          </select>
        </div>
      );
      break;
    case "hqCountries":
      value = countries;
      valid = countries.length > 0;
      body = <CountryPicker value={countries} onChange={setCountries} />;
      break;
    case "industry":
      value = industry.trim();
      valid = industry.trim().length > 0;
      body = (
        <div className="field">
          <label htmlFor={ids.a}>Adjacent industry to include</label>
          <input id={ids.a} className="input" value={industry} onChange={(e) => setIndustry(e.target.value)} />
        </div>
      );
      break;
    case "maxCostDollars":
      value = Math.round(budget * 100) / 100;
      valid = budget > 0 && budget <= 5;
      body = (
        <div className="field">
          <label htmlFor={ids.a}>New spending limit (up to $5.00)</label>
          <input id={ids.a} className="input" type="number" min={0.1} max={5} step={0.25} value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
        </div>
      );
      break;
    default:
      valid = false;
      body = <p className="muted">This change can't be edited here. Approve or decline it.</p>;
  }

  return (
    <div className="editor">
      {body}
      <div className="actions">
        <button
          type="button"
          className="primary-btn"
          disabled={deciding || !valid}
          onClick={() => onSubmit({ approve: true, revisedValue: value, note: `Approved with an edit: ${describeChange(change.field, value, contract)}` })}
        >
          Approve with this change
        </button>
        <button type="button" className="ghost-btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/* ---------- outcome / handback ---------- */

function Outcome({
  snapshot,
  cards,
  maxSpend,
  onApply,
  applying,
  onEditTargeting,
  onNewSearch,
}: {
  snapshot: RunSnapshot;
  cards: CardSet | null;
  maxSpend: number;
  onApply: (patch: SuggestionPatch) => void;
  applying: boolean;
  onEditTargeting: () => void;
  onNewSearch: () => void;
}) {
  const { handback, contract } = snapshot;
  return (
    <section className={`outcome ${handback ? "is-short" : ""}`} aria-labelledby="outcome-h">
      <h2 id="outcome-h">
        {handback
          ? shortfallHeadline(handback.shortfall, snapshot.leads.length, contract.targetLeads)
          : snapshot.leads.length > 0
            ? `Found ${snapshot.leads.length} lead${snapshot.leads.length === 1 ? "" : "s"}`
            : "No leads this time"}
        {UNVERIFIED_SUFFIX((snapshot.candidates ?? []).length)}
      </h2>
      {snapshot.summary && <p className="outcome-summary">{snapshot.summary}</p>}
      {handback && <Handback handback={handback} contract={contract} cards={cards} maxSpend={maxSpend} onApply={onApply} applying={applying} onEditTargeting={onEditTargeting} />}
      <div className="actions">
        <button type="button" className="ghost-btn" onClick={onEditTargeting}>Adjust targeting and run again</button>
        <button type="button" className="link-btn" onClick={onNewSearch}>Start a new search</button>
      </div>
    </section>
  );
}

function Handback({
  handback,
  contract,
  cards,
  maxSpend,
  onApply,
  applying,
  onEditTargeting,
}: {
  handback: Handback;
  contract: ContractView;
  cards: CardSet | null;
  maxSpend: number;
  onApply: (patch: SuggestionPatch) => void;
  applying: boolean;
  onEditTargeting: () => void;
}) {
  const reasons = handback.top_reasons.filter((r) => r.count > 0);
  return (
    <>
      {reasons.length > 0 && (
        <p className="muted">
          Most often turned down for:{" "}
          {reasons.map((r, i) => (
            <span key={r.code}>
              {i > 0 && " · "}
              <b className="ink">{reasonGroup(r.code, "", contract).toLowerCase()}</b> ({r.count})
            </span>
          ))}
        </p>
      )}
      {handback.suggestions.length > 0 && (
        <ul className="suggestions">
          {handback.suggestions.map((s, i) => {
            const patch = cards ? suggestionPatch(s, cards, maxSpend) : null;
            if (!patch && !isChangeField(s.field)) {
              // "none" / "scope": advice, not a change. Show it as a note.
              return s.why ? (
                <li key={i} className="suggestion is-note">
                  <p className="muted">{plainText(s.why, contract)}</p>
                </li>
              ) : null;
            }
            return (
              <li key={i} className="suggestion">
                <div>
                  <p className="suggestion-title">{patch ? patch.label : suggestionTitle(s.field, s.value, contract)}</p>
                  {s.why && <p className="muted">{plainText(s.why, contract)}</p>}
                </div>
                {patch ? (
                  <button type="button" className="primary-btn small" disabled={applying} onClick={() => onApply(patch)}>
                    {applying ? "Preparing…" : "Apply and run again"}
                  </button>
                ) : (
                  <button type="button" className="ghost-btn small" onClick={onEditTargeting}>Adjust targeting</button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/* ---------- leads ---------- */

function Leads({
  leads,
  finished,
  live,
  feedback,
  onFeedback,
}: {
  leads: AcceptedLead[];
  finished: boolean;
  live: boolean;
  feedback: Record<string, Feedback>;
  onFeedback: (company: string, next: Feedback, send: boolean) => void;
}) {
  const exportCsv = () => {
    const blob = new Blob([leadsCsv(leads, feedback)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `prospector-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section className="leads" aria-labelledby="leads-h">
      <div className="section-head">
        <h2 id="leads-h">
          Leads <span className="count">{leads.length}</span>
        </h2>
        {leads.length > 0 && (
          <button type="button" className="ghost-btn small" onClick={exportCsv}>
            <Download /> Download CSV
          </button>
        )}
      </div>
      {leads.length === 0 ? (
        <p className="empty-line">{live ? "Leads appear here as soon as one passes every check." : "No company passed every check."}</p>
      ) : (
        <div className="results">
          <div className="lrow lrow-head" aria-hidden="true">
            <span>Company and fit</span>
            <span>Why now</span>
            <span>Event date</span>
            <span>Size</span>
            <span>Source</span>
            <span>Good lead?</span>
          </div>
          <ul className="lrows">
            {leads.map((lead) => (
              <LeadRow key={lead.company} lead={lead} finished={finished} fb={feedback[lead.company] ?? {}} onFeedback={onFeedback} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function LeadRow({
  lead,
  finished,
  fb,
  onFeedback,
}: {
  lead: AcceptedLead;
  finished: boolean;
  fb: Feedback;
  onFeedback: (company: string, next: Feedback, send: boolean) => void;
}) {
  const size = leadSize(lead);
  const date = leadDate(lead);
  const reasonId = useId();
  return (
    <li className="lrow">
      <div className="cell-company">
        <div className="company-name">{lead.company}</div>
        <div className="fit" title={leadFit(lead)}>{leadFit(lead)}</div>
      </div>
      <div className="cell-why">
        <span className="cell-label">Why now</span>
        {lead.why_now}
      </div>
      <div className="cell-date">
        <span className="cell-label">Event date</span>
        <span className="date-abs">{formatDate(date) || "Unknown"}</span>
      </div>
      <div className="cell-size">
        <span className="cell-label">Size</span>
        <span>{size.text}</span>
        <span className="basis">{size.basis}</span>
      </div>
      <div className="cell-source">
        <span className="cell-label">Source</span>
        {isHttpUrl(lead.signal_url) ? (
          <a href={lead.signal_url} target="_blank" rel="noopener noreferrer">
            <span>{host(lead.signal_url)}</span> <ArrowUpRight />
          </a>
        ) : (
          <span className="no-source">No safe link</span>
        )}
      </div>
      <div className="cell-fb">
        {finished ? (
          fb.sent ? (
            <span className="fb-done">{fb.verdict === "up" ? "Marked good" : "Marked not a fit"}. Remembered for next time.</span>
          ) : (
            <>
              <div className="thumbs" role="group" aria-label={`Is ${lead.company} a good lead?`}>
                <button type="button" className={`thumb ${fb.verdict === "up" ? "is-on" : ""}`} aria-pressed={fb.verdict === "up"} aria-label="Good lead"
                  disabled={fb.sending} onClick={() => onFeedback(lead.company, { verdict: "up", open: true }, false)}>
                  <ThumbUp />
                </button>
                <button type="button" className={`thumb ${fb.verdict === "down" ? "is-on" : ""}`} aria-pressed={fb.verdict === "down"} aria-label="Not a fit"
                  disabled={fb.sending} onClick={() => onFeedback(lead.company, { verdict: "down", open: true }, false)}>
                  <ThumbDown />
                </button>
              </div>
              {fb.open && fb.verdict && (
                <div className="fb-form">
                  <label htmlFor={reasonId} className="sr-only">Why? (optional)</label>
                  <input id={reasonId} className="input small" placeholder="Why? (optional)" value={fb.reason ?? ""}
                    onChange={(e) => onFeedback(lead.company, { ...fb, reason: e.target.value }, false)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onFeedback(lead.company, fb, true);
                    }} />
                  <button type="button" className="ghost-btn small" disabled={fb.sending} onClick={() => onFeedback(lead.company, fb, true)}>
                    {fb.sending ? "Saving…" : "Save"}
                  </button>
                </div>
              )}
              {fb.error && <span className="inline-error small">Couldn't save. Try again.</span>}
            </>
          )
        ) : (
          <span className="muted small">After the run</span>
        )}
      </div>
    </li>
  );
}

/* ---------- rejections ---------- */

function Rejections({
  rejected,
  screenedGroups = [],
  contract,
  finished,
  dropped,
  skipped,
}: {
  rejected: RunSnapshot["rejected"];
  screenedGroups?: NonNullable<RunSnapshot["screened"]>;
  contract: ContractView;
  finished: boolean;
  dropped: string[];
  skipped: string[];
}) {
  const groups = groupRejections(rejected, contract);
  const [open, setOpen] = useState(true);
  // Only after the run: mid-run, a looked-up company may still be about to be submitted.
  const atLookup = screenedGroups
    .filter((g) => g.count > 0)
    .map((g) => ({
      label: `Ruled out at lookup: ${reasonGroup(g.code, "", contract).replace(/^./, (c) => c.toLowerCase())}`,
      items: g.companies,
      count: g.count,
    }));
  const extra = finished
    ? [
        ...(dropped.length ? [{ label: "Looked up, then dropped by the agent as a poor fit", items: dropped }] : []),
        ...(skipped.length ? [{ label: "Skipped as obvious non-fits, without a lookup", items: skipped }] : []),
      ]
    : [];
  const total = rejected.length + atLookup.reduce((n, g) => n + g.count, 0) + extra.reduce((n, g) => n + g.items.length, 0);
  if (total === 0) return null;
  return (
    <section className="rejections" aria-labelledby="rej-h">
      <div className="section-head">
        <h2 id="rej-h">
          Considered but not added <span className="count">{total}</span>
        </h2>
        <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide companies" : "Show companies"}
        </button>
      </div>
      <ul className="rej-groups">
        {groups.map((g) => (
          <li key={g.label} className="rej-group">
            <p className="rej-label">
              <span className="muted">Turned down by the checks:</span> {g.label} <span className="count">{g.items.length}</span>
            </p>
            {open && (
              <ul className="rej-items">
                {g.items.map((item, i) => (
                  <li key={item.company + i}>
                    <b>{item.company}</b> <span className="muted">{item.phrase}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
        {atLookup.map((g) => (
          <li key={g.label} className="rej-group">
            <p className="rej-label">
              {g.label} <span className="count">{g.count}</span>
            </p>
            {open && (
              <p className="rej-names muted">
                {g.items.join(", ")}
                {g.count > g.items.length ? ` and ${g.count - g.items.length} more` : ""}
              </p>
            )}
          </li>
        ))}
        {extra.map((g) => (
          <li key={g.label} className="rej-group">
            <p className="rej-label">
              {g.label} <span className="count">{g.items.length}</span>
            </p>
            {open && <p className="rej-names muted">{g.items.join(", ")}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
