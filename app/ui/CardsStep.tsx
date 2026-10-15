"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { CardSet } from "../../src/planner/cards";
import { COUNTRY_CHOICES, STAGES, countryName, humanize, toSignalKey } from "./copy";
import { Close, Suggestion } from "./parts";

/** Merges one alternative's partial cards over the suggested set (one level deep). */
export function applyAlternative(base: CardSet, alt: Partial<CardSet>): CardSet {
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(alt)) {
    if (key === "rationale" || key === "alternatives" || value === undefined) continue;
    const current = (base as Record<string, unknown>)[key];
    next[key] =
      value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object" && !Array.isArray(current)
        ? { ...(current as object), ...(value as object) }
        : value;
  }
  return next as CardSet;
}

/** What blocks "Build the plan", in plain words. */
export function cardProblems(cards: CardSet): string[] {
  const problems: string[] = [];
  if (!cards.who.industry.trim() || !cards.who.descriptor.trim()) problems.push("Say who you're looking for.");
  if (!cards.whyNow.description.trim()) problems.push("Describe the why-now event.");
  if (cards.whyNow.signalTypes.length === 0) problems.push("Add at least one kind of event.");
  if (!(cards.size.min >= 1) || !(cards.size.max >= 1)) problems.push("Company size needs numbers above zero.");
  else if (cards.size.min > cards.size.max) problems.push("The smallest size is above the largest.");
  return problems;
}

type Props = {
  cards: CardSet;
  base: CardSet;
  activeAlt: number;
  onPickAlt: (index: number) => void;
  onChange: (cards: CardSet) => void;
  onContinue: () => void;
  onBack: () => void;
  busy: boolean;
  error: string;
};

export function CardsStep({ cards, base, activeAlt, onPickAlt, onChange, onContinue, onBack, busy, error }: Props) {
  const problems = cardProblems(cards);
  const set = (patch: Partial<CardSet>) => onChange({ ...cards, ...patch });
  const why = (key: string) => cards.rationale[key] ?? base.rationale[key];

  return (
    <div className="step pr-target">
      {base.alternatives.length > 0 && (
        <div className="pr-alts" role="group" aria-label="Other ways to target">
          <span className="pr-alts-label">Try a different angle</span>
          <Suggestion aria-pressed={activeAlt === -1} onClick={() => onPickAlt(-1)}>
            Suggested
          </Suggestion>
          {base.alternatives.map((alt, i) => (
            <Suggestion key={alt.label + i} aria-pressed={activeAlt === i} onClick={() => onPickAlt(i)}>
              {alt.label}
            </Suggestion>
          ))}
        </div>
      )}

      <p className="pr-legend">
        <Kind kind="hard" /> applied exactly.{" "}
        <Kind kind="est" /> judged from public info about each company, so treat it as approximate.
      </p>

      <div className="pr-form">
        <Row title="Who" why={why("who")}>
          <Field label="Industry">
            {(id) => <input id={id} className="input" value={cards.who.industry} onChange={(e) => set({ who: { ...cards.who, industry: e.target.value } })} />}
          </Field>
          <Field label="Kind of company">
            {(id) => <input id={id} className="input" value={cards.who.descriptor} onChange={(e) => set({ who: { ...cards.who, descriptor: e.target.value } })} />}
          </Field>
        </Row>

        <Row title="Why now" why={why("whyNow")}>
          <Field label="The event that makes them ready to buy">
            {(id) => (
              <textarea id={id} className="input" rows={2} value={cards.whyNow.description} onChange={(e) => set({ whyNow: { ...cards.whyNow, description: e.target.value } })} />
            )}
          </Field>
          <ChipList
            label="Kinds of event, most valuable first"
            items={cards.whyNow.signalTypes}
            display={humanize}
            addLabel="Add a kind of event"
            onChange={(signalTypes) => set({ whyNow: { ...cards.whyNow, signalTypes } })}
            normalize={toSignalKey}
            max={6}
          />
        </Row>

        <Row title="Company size" kind="est" why={why("size")}>
          <div className="pair">
            <Field label="From (employees)">
              {(id) => (
                <input id={id} className="input" type="number" inputMode="numeric" min={1} value={Number.isFinite(cards.size.min) ? cards.size.min : ""}
                  onChange={(e) => set({ size: { ...cards.size, min: Number(e.target.value) } })} />
              )}
            </Field>
            <Field label="To (employees)">
              {(id) => (
                <input id={id} className="input" type="number" inputMode="numeric" min={1} value={Number.isFinite(cards.size.max) ? cards.size.max : ""}
                  onChange={(e) => set({ size: { ...cards.size, max: Number(e.target.value) } })} />
              )}
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={cards.size.unknownPolicy === "allow-if-not-enterprise"}
              onChange={(e) => set({ size: { ...cards.size, unknownPolicy: e.target.checked ? "allow-if-not-enterprise" : "reject" } })} />
            <span>Include companies whose size isn't published, unless they look like a large enterprise</span>
          </label>
        </Row>

        <Row title="Stage" kind="est" why={why("stage")}>
          <Field label="Funding stage">
            {(id) => (
              <select id={id} className="input" value={cards.stage ?? "any"} onChange={(e) => set({ stage: e.target.value as CardSet["stage"] })}>
                {STAGES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            )}
          </Field>
        </Row>

        <Row title="Where they're based" kind="est" why={why("geo")}>
          <CountryPicker value={cards.geo.hqCountries} onChange={(hqCountries) => set({ geo: { hqCountries } })} />
        </Row>

        <Row title="How recent" kind="hard" why={why("recency")}>
          <Field label="Only events from the last">
            {(id) => (
              <select id={id} className="input" value={cards.recency.months} onChange={(e) => set({ recency: { months: Number(e.target.value) } })}>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <option key={m} value={m}>{m} month{m === 1 ? "" : "s"}</option>
                ))}
              </select>
            )}
          </Field>
        </Row>

        <Row title="Leave out" kind="hard" why={why("exclusions")}>
          <ChipList
            label="Companies (customers, competitors, giants)"
            items={cards.exclusions.names}
            addLabel="Add a company to leave out"
            onChange={(names) => set({ exclusions: { ...cards.exclusions, names } })}
            collapsedAfter={10}
          />
          <ChipList
            label="Websites to ignore as sources"
            items={cards.exclusions.domains}
            addLabel="Add a website, e.g. example.com"
            onChange={(domains) => set({ exclusions: { ...cards.exclusions, domains } })}
            normalize={(v) => v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")}
          />
        </Row>
      </div>

      {error && (
        <p className="inline-error" role="alert">{error}</p>
      )}
      {problems.length > 0 && (
        <ul className="pr-problems" aria-live="polite">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}

      <div className="actions">
        <button type="button" className="ghost-btn" onClick={onBack} disabled={busy}>Back</button>
        <button type="button" className="primary-btn" onClick={onContinue} disabled={busy || problems.length > 0}>
          {busy ? "Building the plan…" : "Build the plan"}
        </button>
      </div>
    </div>
  );
}

function Kind({ kind }: { kind: "hard" | "est" }) {
  return (
    <Badge variant="outline" className="pr-kind" data-kind={kind}>
      {kind === "hard" ? "Hard filter" : "Estimated"}
    </Badge>
  );
}

/** One hairline row of the targeting form: label column (title, Badge, "Why this?") beside its controls. */
function Row({ title, kind, why, children }: { title: string; kind?: "hard" | "est"; why?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="pr-row" aria-labelledby={id}>
      <div className="pr-row-label">
        <div className="pr-row-head">
          <h3 id={id}>{title}</h3>
          {kind && <Kind kind={kind} />}
        </div>
        {why && (
          <Collapsible className="pr-why">
            <CollapsibleTrigger className="pr-why-trigger">
              <ChevronRightIcon aria-hidden="true" className="pr-why-chevron" />
              Why this?
            </CollapsibleTrigger>
            <CollapsibleContent className="pr-why-panel">
              <p>{why}</p>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
      <div className="pr-row-controls">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  );
}

function ChipList({
  label,
  items,
  onChange,
  addLabel,
  display = (v) => v,
  normalize = (v) => v.trim(),
  max,
  collapsedAfter,
}: {
  label: string;
  items: string[];
  onChange: (items: string[]) => void;
  addLabel: string;
  display?: (v: string) => string;
  normalize?: (v: string) => string;
  max?: number;
  collapsedAfter?: number;
}) {
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const add = () => {
    const value = normalize(draft);
    if (!value || items.includes(value) || (max !== undefined && items.length >= max)) return;
    onChange([...items, value]);
    setDraft("");
  };
  const shown = collapsedAfter && !expanded ? items.slice(0, collapsedAfter) : items;
  return (
    <div className="field">
      <span className="field-label" id={`${id}-label`}>{label}</span>
      <ul className="chips" aria-labelledby={`${id}-label`}>
        {items.length === 0 && <li className="chips-empty">None</li>}
        {shown.map((item) => (
          <li key={item} className="chip">
            <span>{display(item)}</span>
            <button type="button" className="chip-x" aria-label={`Remove ${display(item)}`} onClick={() => onChange(items.filter((i) => i !== item))}>
              <Close />
            </button>
          </li>
        ))}
        {collapsedAfter && items.length > collapsedAfter && (
          <li>
            <button type="button" className="link-btn" onClick={() => setExpanded(!expanded)}>
              {expanded ? "Show fewer" : `and ${items.length - collapsedAfter} more`}
            </button>
          </li>
        )}
      </ul>
      {(max === undefined || items.length < max) && (
        <div className="chip-add">
          <input
            className="input"
            aria-label={addLabel}
            placeholder={addLabel}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <button type="button" className="ghost-btn small" onClick={add} disabled={!normalize(draft)}>Add</button>
        </div>
      )}
    </div>
  );
}

export function CountryPicker({ value, onChange }: { value: string[]; onChange: (codes: string[]) => void }) {
  const id = useId();
  const options = COUNTRY_CHOICES.filter((c) => !value.includes(c)).sort((a, b) => countryName(a).localeCompare(countryName(b)));
  return (
    <div className="field">
      <span className="field-label" id={`${id}-label`}>Company HQ in</span>
      <ul className="chips" aria-labelledby={`${id}-label`}>
        {value.length === 0 && <li className="chips-empty">Anywhere</li>}
        {value.map((code) => (
          <li key={code} className="chip">
            <span>{countryName(code)}</span>
            <button type="button" className="chip-x" aria-label={`Remove ${countryName(code)}`} onClick={() => onChange(value.filter((c) => c !== code))}>
              <Close />
            </button>
          </li>
        ))}
      </ul>
      <select
        className="input"
        aria-label="Add a country"
        value=""
        onChange={(e) => {
          if (e.target.value) onChange([...value, e.target.value]);
        }}
      >
        <option value="">Add a country…</option>
        {options.map((c) => (
          <option key={c} value={c}>{countryName(c)}</option>
        ))}
      </select>
    </div>
  );
}
