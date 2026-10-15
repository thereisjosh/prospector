"use client";

/**
 * A pending approval (docs/UI-REWORK.md §1a): a Confirmation, outside the Trace, because it is a
 * prompt and not activity. The strategy body is a Plan (angles and first searches as pending steps,
 * the estimate as its description). Scope changes keep their domain editors. It takes focus when it
 * appears (the run is blocked on it) and is fully keyboard-operable: Tab to Approve, Enter.
 */
import { useEffect, useId, useRef, useState } from "react";
import { CircleIcon, SearchIcon } from "lucide-react";
import { Item, ItemActions, ItemContent, ItemDescription } from "@/components/ui/item";
import { CountryPicker } from "./CardsStep";
import { describeChange, money, readScopeChange, type ContractView } from "./copy";

export type Decision = { approve: boolean; note?: string; revisedValue?: unknown };
export type PendingApproval = { toolUseId?: string; tool: string; input: unknown };

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
}

export function RunConfirmation({
  demo,
  pending,
  contract,
  deciding,
  error,
  onDecide,
  leaving = false,
}: {
  demo: boolean;
  pending: PendingApproval;
  contract: ContractView;
  deciding: boolean;
  error: string;
  onDecide: (d: Decision) => void;
  /** The resolved copy, fading out along the path it came in on (M4). Inert. */
  leaving?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const isStrategy = pending.tool === "propose_strategy";
  const input = (pending.input ?? {}) as Record<string, unknown>;
  const titleId = useId();
  // A native element: React 18 drops refs passed to shadcn components (UI-REWORK.md §4, error 9).
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!leaving) heading.current?.focus();
  }, [leaving]);

  const angles = strings(input.angles);
  const queries = strings(input.first_queries);
  const disabled = deciding || leaving;

  return (
    <Item
      variant="outline"
      render={<section />}
      aria-labelledby={titleId}
      aria-hidden={leaving || undefined}
      data-leaving={leaving || undefined}
      className="pr-confirm"
    >
      <ItemContent className="min-w-0 gap-3">
        {isStrategy ? (
          <>
            <h2 id={titleId} ref={heading} tabIndex={-1} className="pr-confirm-title">
              Here's how the agent plans to start
            </h2>
            <div className="pr-plan">
              {angles.length > 0 && (
                <div>
                  <h3 className="pr-plan-label">Angles</h3>
                  <ul className="pr-plan-steps">
                    {angles.map((a) => (
                      <li key={a}>
                        <CircleIcon aria-hidden="true" className="pr-plan-icon" />
                        <span>{a}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {queries.length > 0 && (
                <div>
                  <h3 className="pr-plan-label">First searches</h3>
                  <ul className="pr-plan-steps">
                    {queries.map((q) => (
                      <li key={q}>
                        <SearchIcon aria-hidden="true" className="pr-plan-icon" />
                        <span className="pr-mono">{q}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            {typeof input.est_cost_dollars === "number" && (
              <ItemDescription className="line-clamp-none text-[length:var(--t-base)]">
                Its estimate for the whole run: <b className="ink">{money(input.est_cost_dollars)}</b> (your limit is {money(contract.maxCostDollars)}).
              </ItemDescription>
            )}
          </>
        ) : (
          <ScopeSummary input={pending.input} contract={contract} titleId={titleId} heading={heading} />
        )}

        {demo && <p className="pr-confirm-demo">Demo: the recorded run continues the same way whichever you choose.</p>}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}

        {editing ? (
          isStrategy ? (
            <StrategyEditor deciding={disabled} onCancel={() => setEditing(false)} onSubmit={(note) => onDecide({ approve: true, note, revisedValue: note })} />
          ) : (
            <ScopeEditor input={pending.input} contract={contract} deciding={disabled} onCancel={() => setEditing(false)} onSubmit={onDecide} />
          )
        ) : (
          <ItemActions className="flex-wrap">
            <button type="button" className="primary-btn" disabled={disabled} onClick={() => onDecide({ approve: true })}>
              {deciding ? "Sending…" : "Approve"}
            </button>
            <button type="button" className="ghost-btn" disabled={disabled} onClick={() => setEditing(true)}>
              Edit
            </button>
            <button type="button" className="ghost-btn danger" disabled={disabled} onClick={() => onDecide({ approve: false })}>
              Decline
            </button>
          </ItemActions>
        )}
      </ItemContent>
    </Item>
  );
}

function ScopeSummary({
  input,
  contract,
  titleId,
  heading,
}: {
  input: unknown;
  contract: ContractView;
  titleId: string;
  heading: React.RefObject<HTMLHeadingElement>;
}) {
  const change = readScopeChange(input);
  return (
    <>
      <h2 id={titleId} ref={heading} tabIndex={-1} className="pr-confirm-title">
        The agent wants to change your targeting
      </h2>
      <p className="change-line">{describeChange(change.field, change.value, contract)}</p>
      {change.reason && (
        <p className="m-0">
          <span className="muted">Why: </span>
          {change.reason}
        </p>
      )}
      {change.evidence && (
        <p className="m-0">
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
        <button type="button" className="ghost-btn" onClick={onCancel}>
          Cancel
        </button>
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
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <option key={m} value={m}>
                {m} month{m === 1 ? "" : "s"}
              </option>
            ))}
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
        <button type="button" className="ghost-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
