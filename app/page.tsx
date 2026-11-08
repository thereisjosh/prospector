"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IcpId, ProspectRow } from "../src/types";

type SortKey = "conf" | "date";

type Scenario = {
  id: IcpId;
  name: string;
  blurb: string;
  window: string;
  gate: string;
  /** Plain-English ICP shown in the search box. */
  query: string;
};

const SCENARIOS: Scenario[] = [
  {
    id: 1,
    name: "Logistics, scaling",
    blurb: "3PLs opening facilities",
    window: "last 3 months",
    gate: "US · mid-market · on-domain",
    query:
      "mid-market logistics / 3PL companies clearly scaling their operations — US, ~100–1,000 employees",
  },
  {
    id: 2,
    name: "Payments launch",
    blurb: "SaaS shipping billing",
    window: "last 3 months",
    gate: "US · B2B SaaS · not a PSP",
    query:
      "B2B SaaS or marketplaces that just launched or expanded payments or billing — US, ~100–800 employees",
  },
  {
    id: 3,
    name: "Newly funded",
    blurb: "First ops / RevOps hire",
    window: "last 6 months",
    gate: "US · seed / Series A · ops hire",
    query:
      "B2B companies that raised seed / Series A in the last ~6 months and are hiring their first ops / RevOps person",
  },
];

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Only http(s) URLs may become links; anything else (javascript:, data:, ...) renders as text. */
function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function barWidth(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function isHiringSignal(row: ProspectRow): boolean {
  return /hir|ops|role|posting/i.test(row.signal_strength);
}

/** Tighten the raw signal label for the pill: drop "new …" and "… signal" filler. */
function signalLabel(raw: string): string {
  return raw.replace(/^new\s+/i, "").replace(/\s+signal$/i, "").trim() || raw;
}

function relativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const days = Math.round((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

function sortRows(rows: ProspectRow[], sort: SortKey): ProspectRow[] {
  return [...rows].sort((a, b) => {
    if (sort === "date") return a.signal_date < b.signal_date ? 1 : -1;
    return b.confidence_score - a.confidence_score;
  });
}

type RunStats = { count: number; cost: number; seconds: number } | null;

export default function Page() {
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState(SCENARIOS[0].query);
  const [rows, setRows] = useState<ProspectRow[]>([]);
  const [sort, setSort] = useState<SortKey>("conf");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [stats, setStats] = useState<RunStats>(null);
  const [hasRun, setHasRun] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scenario = SCENARIOS[active];
  const sortedRows = useMemo(() => sortRows(rows, sort), [rows, sort]);

  const runSearch = useCallback(
    async (index: number, queryText: string) => {
      const target = SCENARIOS[index];
      const edited = queryText.trim() !== target.query.trim();
      setError("");
      setLoading(true);

      const started = performance.now();
      try {
        const response = await fetch("/api/prospect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            icpId: target.id,
            query: edited ? queryText.trim() : undefined,
          }),
        });
        const data = (await response.json()) as {
          rows?: ProspectRow[];
          costDollars?: number;
          error?: string;
        };
        if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);

        const nextRows = data.rows ?? [];
        setRows(nextRows);
        setStats({
          count: nextRows.length,
          cost: data.costDollars ?? 0,
          seconds: (performance.now() - started) / 1000,
        });
      } catch (err) {
        setRows([]);
        setStats(null);
        setError(err instanceof Error ? err.message : "Request failed.");
      } finally {
        setLoading(false);
        setHasRun(true);
      }
    },
    [],
  );

  useEffect(() => {
    const root = document.documentElement;
    const current =
      root.getAttribute("data-theme") ??
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    setDark(current === "dark");
  }, []);

  function selectScenario(index: number) {
    setActive(index);
    setQuery(SCENARIOS[index].query);
    setError("");
  }

  function toggleTheme() {
    const next = dark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    setDark(!dark);
  }

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">
          <Crosshair />
          <span>Prospector</span>
        </div>

        <nav className="scenarios" aria-label="Scenarios">
          <p className="rail-label">Scenarios</p>
          {SCENARIOS.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className={`scenario ${active === index ? "is-active" : ""}`}
              onClick={() => selectScenario(index)}
            >
              <span className="scenario-name">{item.name}</span>
              <span className="scenario-blurb">{item.blurb}</span>
            </button>
          ))}
        </nav>

        <div className="rail-foot">
          <button type="button" className="rail-link" onClick={() => setAboutOpen(true)}>
            About this build
          </button>
          <a
            className="rail-link"
            href="https://github.com/thereisjosh/prospector"
            target="_blank"
            rel="noopener noreferrer"
          >
            View source <ArrowUpRight />
          </a>
          <p className="rail-powered">Powered by Exa Search</p>
        </div>
      </aside>

      <div className="stage">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{scenario.name}</h1>
            <p>Trigger-based prospecting</p>
          </div>
          <div className="topbar-actions">
            <span className="live" title="Every run queries Exa live on the server key">
              <span className="live-dot" /> Live on Exa
            </span>
            <button
              type="button"
              className="icon-btn"
              onClick={toggleTheme}
              aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
            >
              {dark ? <Sun /> : <Moon />}
            </button>
          </div>
        </header>

        <main className="content">
          <section className="search" aria-label="Search">
            <label className="search-field">
              <textarea
                ref={inputRef}
                rows={2}
                spellCheck={false}
                placeholder="Describe the customer you're looking for…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void runSearch(active, query);
                  }
                }}
              />
              <button
                type="button"
                className="search-go"
                disabled={loading}
                onClick={() => void runSearch(active, query)}
              >
                {loading ? "Searching…" : "Find companies"}
              </button>
            </label>

            <p className="meta">
              <span>
                Freshness <b>{scenario.window}</b>
              </span>
              <span className="meta-dot" />
              <span>
                Signal-first <b>neural</b>
              </span>
              <span className="meta-dot" />
              <span>
                Gate <b>{scenario.gate}</b>
              </span>
            </p>
          </section>

          {(rows.length > 0 || loading) && (
            <div className="results-bar">
              <span className="results-count">
                {loading ? (
                  "Querying Exa…"
                ) : (
                  <>
                    <b>{rows.length}</b> {rows.length === 1 ? "company" : "companies"}
                    {stats && (
                      <span className="results-stats">
                        {" "}
                        · ${stats.cost.toFixed(3)} · {stats.seconds.toFixed(1)}s
                      </span>
                    )}
                  </>
                )}
              </span>
              {!loading && rows.length > 0 && (
                <label className="sort">
                  Sort
                  <select
                    value={sort}
                    onChange={(event) => setSort(event.target.value as SortKey)}
                  >
                    <option value="conf">Confidence</option>
                    <option value="date">Most recent</option>
                  </select>
                </label>
              )}
            </div>
          )}

          {loading ? (
            <ResultsTable>
              {Array.from({ length: 5 }).map((_, index) => (
                <div className="row row-skeleton" key={index}>
                  <span className="sk sk-lg" />
                  <span className="sk" />
                  <span className="sk" />
                  <span className="sk" />
                  <span className="sk" />
                </div>
              ))}
            </ResultsTable>
          ) : error ? (
            <div className="state state-error">
              <AlertIcon />
              <p>{error}</p>
              <button type="button" className="ghost-btn" onClick={() => void runSearch(active, query)}>
                Try again
              </button>
            </div>
          ) : rows.length > 0 ? (
            <ResultsTable>
              {sortedRows.map((row, index) => (
                <ResultRow
                  key={`${row.company}-${row.signal_source_url}-${row.signal_date}`}
                  row={row}
                  index={index}
                />
              ))}
            </ResultsTable>
          ) : (
            <div className="state state-empty">
              <div className="state-icon">
                <Crosshair />
              </div>
              <h2>{hasRun ? "No companies matched" : "Ready to prospect"}</h2>
              <p>
                {hasRun
                  ? "No companies cleared the fit gate for this scenario. Try another scenario or widen the description."
                  : "Pick a scenario, refine the description if you like, then find companies with a fresh, cited why-now signal."}
              </p>
              {!hasRun && (
                <button
                  type="button"
                  className="primary-btn"
                  onClick={() => void runSearch(active, query)}
                >
                  Find companies
                </button>
              )}
            </div>
          )}
        </main>
      </div>

      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
    </div>
  );
}

function ResultsTable({ children }: { children: React.ReactNode }) {
  return (
    <div className="results">
      <div className="row row-head">
        <span>Company &amp; why-now signal</span>
        <span>Signal</span>
        <span>Detected</span>
        <span>Confidence</span>
        <span>Source</span>
      </div>
      {children}
    </div>
  );
}

function ResultRow({ row, index }: { row: ProspectRow; index: number }) {
  const rel = relativeDate(row.signal_date);
  return (
    <div className="row row-data" style={{ animationDelay: `${Math.min(index, 12) * 28}ms` }}>
      <div className="cell-company">
        <div className="company-name">
          {row.net_new && <span className="net-new" title="Net-new vs the baseline list" />}
          {row.company}
        </div>
        <div className="why-now">{row.why_now_signal}</div>
      </div>
      <div className="cell-signal">
        <span className={`signal-tag ${isHiringSignal(row) ? "is-hire" : "is-strong"}`}>
          {signalLabel(row.signal_strength)}
        </span>
      </div>
      <div className="cell-date">
        <span className="date-abs">{row.signal_date}</span>
        {rel && <span className="date-rel">{rel}</span>}
      </div>
      <div className="cell-conf">
        <div className="conf-track">
          <div className="conf-fill" style={{ width: barWidth(row.confidence_score) }} />
        </div>
        <span className="conf-value">{row.confidence_score.toFixed(2)}</span>
      </div>
      <div className="cell-source">
        {row.signal_source_url && isHttpUrl(row.signal_source_url) ? (
          <a href={row.signal_source_url} target="_blank" rel="noopener noreferrer">
            {host(row.signal_source_url)} <ArrowUpRight />
          </a>
        ) : row.signal_source_url ? (
          <span className="no-source">{host(row.signal_source_url) || "unsafe link"}</span>
        ) : (
          <span className="no-source">—</span>
        )}
      </div>
    </div>
  );
}

function AboutDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="about-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog">
        <button type="button" className="icon-btn dialog-close" onClick={onClose} aria-label="Close">
          <Close />
        </button>
        <h2 id="about-title">About this build</h2>
        <p>
          Prospector turns a plain-English customer profile into a shortlist of companies, each
          matched by a fresh, cited <b>why-now trigger</b> — a new facility, a funding round, a
          hiring wave. It runs a signal-first pipeline: a date-filtered trigger search, company
          enrichment, a firmographic fit gate, then confidence scoring.
        </p>
        <p className="dialog-sub">Where this fits at Exa</p>
        <ul className="fit-list">
          <li>
            <b>Sales / Enrichment</b>
            <span>11x · HubSpot · HockeyStack</span>
          </li>
          <li>
            <b>Agents</b>
            <span>Cognition · StackAI · monday</span>
          </li>
          <li>
            <b>Coding</b>
            <span>Cognition · CodeRabbit · Cursor</span>
          </li>
        </ul>
        <p className="dialog-foot">
          Built AI-assisted; architecture, API design, and evaluation by Joshua Ang.{" "}
          <a href="https://github.com/thereisjosh/prospector" target="_blank" rel="noopener noreferrer">
            github.com/thereisjosh/prospector
          </a>
        </p>
      </div>
    </div>
  );
}

/* ---------- icons ---------- */

function Crosshair() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="10" cy="10" r="6.25" />
      <path d="M10 1.5v3M10 15.5v3M1.5 10h3M15.5 10h3" strokeLinecap="round" />
      <circle cx="10" cy="10" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ArrowUpRight() {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M3.5 8.5 8.5 3.5M4.5 3.5h4v4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Moon() {
  return (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M15 10.2A6.2 6.2 0 1 1 7.8 3a4.8 4.8 0 0 0 7.2 7.2Z" strokeLinejoin="round" />
    </svg>
  );
}

function Sun() {
  return (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="9" cy="9" r="3.4" />
      <path
        d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.6 3.6l1.4 1.4M13 13l1.4 1.4M14.4 3.6 13 5M5 13l-1.4 1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Close() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" strokeLinecap="round" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5M12 16h.01" strokeLinecap="round" />
    </svg>
  );
}
