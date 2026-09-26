"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { IcpId, ProspectRow } from "../src/types";

type Mode = "demo" | "live";
type SortKey = "conf" | "fresh" | "date";
type StatusKind = "" | "err" | "ok" | "load";

type Preset = {
  id: IcpId;
  months: number;
  win: string;
  query: string;
  signalQuery: string;
  gate: string;
};

const PRESETS: Preset[] = [
  {
    id: 1,
    months: 3,
    win: "last 3 months",
    query: "mid-market logistics / 3PL companies clearly scaling their operations - US, ~100-1,000 employees",
    signalQuery: "US logistics or 3PL company opening a new warehouse or distribution center, or hiring a wave of operations manager roles",
    gate: "US/UK · mid-market · on-domain",
  },
  {
    id: 2,
    months: 3,
    win: "last 3 months",
    query: "B2B SaaS / marketplaces that just launched or expanded payments or billing - US, ~100-800 employees",
    signalQuery: "US B2B SaaS or marketplace that just launched or expanded embedded payments or billing, or is hiring billing or revenue operations",
    gate: "US · B2B SaaS · not PSP",
  },
  {
    id: 3,
    months: 6,
    win: "last 6 months",
    query: "B2B companies that raised seed / Series A in the last ~6 months and are hiring their first Ops/RevOps person",
    signalQuery: "recently funded seed or Series A US B2B startup hiring its first operations or RevOps person",
    gate: "US · seed/Series A · ops hire",
  },
];

const PRESET_LABELS = [
  "Logistics · scaling ops",
  "B2B SaaS · launched payments",
  "Newly funded · first ops hire",
];

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function barWidth(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function signalClass(row: ProspectRow): "hire" | "strong" {
  return /hire|hiring|ops/i.test(row.signal_strength) ? "hire" : "strong";
}

function sortRows(rows: ProspectRow[], sort: SortKey): ProspectRow[] {
  return [...rows].sort((a, b) => {
    if (sort === "date") return a.signal_date < b.signal_date ? 1 : -1;
    if (sort === "fresh") return b.freshness_score - a.freshness_score;
    return b.confidence_score - a.confidence_score;
  });
}

export default function Page() {
  const [active, setActive] = useState(0);
  const [mode, setModeState] = useState<Mode>("demo");
  const [query, setQuery] = useState(PRESETS[0].query);
  const [apiKey, setApiKey] = useState("");
  const [rows, setRows] = useState<ProspectRow[]>([]);
  const [costDollars, setCostDollars] = useState(0);
  const [sort, setSort] = useState<SortKey>("conf");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ kind: StatusKind; text: string }>({
    kind: "",
    text: "",
  });
  const [aboutOpen, setAboutOpen] = useState(false);

  const preset = PRESETS[active];
  const sortedRows = useMemo(() => sortRows(rows, sort), [rows, sort]);

  const runSearch = useCallback(
    async (overrides?: { index?: number; mode?: Mode; query?: string }) => {
      const nextIndex = overrides?.index ?? active;
      const nextMode = overrides?.mode ?? mode;
      const nextPreset = PRESETS[nextIndex];
      const nextQuery =
        overrides?.query ??
        query.trim() ??
        (nextMode === "live" ? nextPreset.signalQuery : nextPreset.query);

      setStatus({ kind: "", text: "" });

      if (nextMode === "live" && !apiKey.trim()) {
        setStatus({
          kind: "err",
          text: "Add your Exa API key (below the search box) to run live.",
        });
        return;
      }

      setLoading(true);
      if (nextMode === "live") {
        setStatus({ kind: "load", text: "Searching Exa..." });
      }

      try {
        if (nextMode === "live") {
          localStorage.setItem("exa_key", apiKey.trim());
        }
        const response = await fetch("/api/prospect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            icpId: nextPreset.id,
            apiKey: nextMode === "live" ? apiKey.trim() : "",
            query: nextMode === "live" ? nextQuery : undefined,
          }),
        });
        const data = (await response.json()) as {
          rows?: ProspectRow[];
          costDollars?: number;
          error?: string;
        };
        if (!response.ok) {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }
        const nextRows = data.rows ?? [];
        setRows(nextRows);
        setCostDollars(data.costDollars ?? 0);
        if (nextMode === "live") {
          setStatus({
            kind: "ok",
            text: `Live · ${nextRows.length} results · $${(data.costDollars ?? 0).toFixed(3)} on your key`,
          });
        }
      } catch (error) {
        setRows([]);
        setStatus({
          kind: "err",
          text: error instanceof Error ? error.message : "Request failed.",
        });
      } finally {
        setLoading(false);
      }
    },
    [active, apiKey, mode, query],
  );

  useEffect(() => {
    const saved = localStorage.getItem("exa_key");
    if (saved) setApiKey(saved);
    void runSearch({ index: 0, mode: "demo", query: PRESETS[0].query });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handlePreset(index: number) {
    const nextPreset = PRESETS[index];
    const nextQuery = mode === "live" ? nextPreset.signalQuery : nextPreset.query;
    setActive(index);
    setQuery(nextQuery);
    void runSearch({ index, query: nextQuery });
  }

  function handleMode(nextMode: Mode) {
    const nextQuery = nextMode === "live" ? preset.signalQuery : preset.query;
    setModeState(nextMode);
    setQuery(nextQuery);
    setStatus({ kind: "", text: "" });
    if (nextMode === "demo") {
      void runSearch({ mode: "demo", query: nextQuery });
    }
  }

  function handleTheme() {
    const root = document.documentElement;
    let current = root.getAttribute("data-theme");
    if (!current) {
      current = matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    root.setAttribute("data-theme", current === "dark" ? "light" : "dark");
  }

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <span className="mark" /> Prospector
        </div>
        <nav className="nav">
          <div className="lab">WORKSPACE</div>
          <button className="ni on" type="button">
            <SearchIcon /> Search
          </button>
          <button className="ni" type="button">
            <ListIcon /> Saved lists
          </button>
          <button className="ni" type="button">
            <ClockIcon /> History
          </button>
          <div className="lab">ACCOUNT</div>
          <button className="ni" type="button" onClick={() => handleMode("live")}>
            <KeyIcon /> API key
          </button>
          <button className="ni" type="button" onClick={() => setAboutOpen(true)}>
            <InfoIcon /> About
          </button>
        </nav>
        <div className="foot">
          Powered by Exa Search API
          <br />
          <a
            href="https://github.com/thereisjosh/prospector"
            target="_blank"
            rel="noopener noreferrer"
          >
            github ↗
          </a>{" "}
          · v0.5
        </div>
      </aside>

      <main className="main">
        <div className="top">
          <span className="title">Search</span>
          <span className="crumb">/ prospecting</span>
          <span className="right">
            <span className="seg">
              <button
                type="button"
                className={mode === "demo" ? "on" : ""}
                onClick={() => handleMode("demo")}
              >
                Demo
              </button>
              <button
                type="button"
                className={mode === "live" ? "on" : ""}
                onClick={() => handleMode("live")}
              >
                Live
              </button>
            </span>
            <button
              className="icobtn"
              type="button"
              title="Theme"
              aria-label="Toggle theme"
              onClick={handleTheme}
            >
              ◐
            </button>
            <span className="avatar">JA</span>
          </span>
        </div>

        <div className="body">
          <div className="searchcard">
            <div className="searchrow">
              <label className="sinput">
                <span className="lens" />
                <input
                  spellCheck={false}
                  placeholder="Describe your ideal customer in plain English..."
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void runSearch();
                  }}
                />
              </label>
              <button
                className="sbtn"
                type="button"
                disabled={loading}
                onClick={() => void runSearch()}
              >
                Search
              </button>
            </div>
            <div className="presets">
              <span className="plab">Presets</span>
              {PRESET_LABELS.map((label, index) => (
                <button
                  className={`preset ${active === index ? "on" : ""}`}
                  type="button"
                  key={label}
                  onClick={() => handlePreset(index)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className={`keybar ${mode === "live" ? "show" : ""}`}>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="Your Exa API key (exa.ai - free tier)"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <span className="hint">
                stored in your browser · sent only to this backend run
              </span>
            </div>
          </div>

          <div className="filters">
            <span className="fchip">
              freshness: <b>{preset.win}</b>
            </span>
            <span className="fchip">
              signal-first · <b>neural</b>
            </span>
            <span className="fchip">
              gate: <b>{preset.gate}</b>
            </span>
            <span className="rcount">
              {rows.length > 0 ? (
                <>
                  <b>{rows.length}</b> companies
                </>
              ) : null}
            </span>
            <select
              className="sort"
              value={sort}
              onChange={(event) => setSort(event.target.value as SortKey)}
            >
              <option value="conf">sort: confidence</option>
              <option value="fresh">sort: freshness</option>
              <option value="date">sort: date</option>
            </select>
          </div>
          <div className={`status ${status.kind}`}>{status.text}</div>

          <div className="tbl">
            <div className="thead">
              <span>Company</span>
              <span>Why-now signal</span>
              <span>Date</span>
              <span>Confidence</span>
              <span>Source</span>
            </div>
            <div>
              {loading ? (
                <>
                  <div className="skel" />
                  <div className="skel" />
                  <div className="skel" />
                </>
              ) : sortedRows.length > 0 ? (
                sortedRows.map((row) => <ResultRow key={`${row.company}-${row.signal_source_url}-${row.signal_date}`} row={row} />)
              ) : (
                <div className="empty">
                  <div className="big">⌕</div>
                  No companies yet - pick a preset or hit Search.
                </div>
              )}
            </div>
          </div>
          {mode === "demo" && costDollars === 0 ? null : null}
        </div>
      </main>

      <div
        className={`about ${aboutOpen ? "show" : ""}`}
        onClick={(event) => {
          if (event.target === event.currentTarget) setAboutOpen(false);
        }}
      >
        <div className="aboutcard">
          <button className="x" type="button" onClick={() => setAboutOpen(false)}>
            ×
          </button>
          <h3>Prospector</h3>
          <p>
            A natural-language prospecting agent built on the{" "}
            <b style={{ color: "var(--ink)" }}>Exa Search API</b>. It finds
            companies by a fresh, cited{" "}
            <b style={{ color: "var(--ink)" }}>“why-now” trigger</b> - a new
            facility, a funding round, a hiring wave - using a signal-first
            pipeline (date-filtered signal search → company enrichment →
            fit-gated scoring).
          </p>
          <p style={{ marginTop: 12 }}>
            <b style={{ color: "var(--ink)" }}>Where this fits at Exa</b> - a
            working proof of the{" "}
            <b style={{ color: "var(--ink)" }}>Sales / Enrichment</b> category,
            the same web-sourced trigger prospecting Exa&apos;s own customers
            use:
          </p>
          <div className="catrow">
            <b>Sales / Enrichment</b>
            <span>11x · HubSpot · HockeyStack</span>
          </div>
          <div className="catrow">
            <b>Agents</b>
            <span>Cognition · StackAI · monday</span>
          </div>
          <div className="catrow">
            <b>Coding</b>
            <span>Cognition · CodeRabbit · Cursor</span>
          </div>
          <p style={{ marginTop: 14, fontSize: ".82rem" }}>
            Built AI-assisted; architecture, API design, and evaluation by{" "}
            <b style={{ color: "var(--ink)" }}>Joshua Ang</b>. Code, eval
            harness and write-up →{" "}
            <a
              href="https://github.com/thereisjosh/prospector"
              target="_blank"
              rel="noopener noreferrer"
            >
              github.com/thereisjosh/prospector
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

function ResultRow({ row }: { row: ProspectRow }) {
  return (
    <div className="trow">
      <div className="cell-co">
        <div className="n">
          {row.net_new ? <span className="ndot" title="net-new" /> : null}
          {row.company}
        </div>
        <div className="w">{row.why_now_signal}</div>
      </div>
      <div>
        <span className={`pill ${signalClass(row)}`}>{row.signal_strength}</span>
      </div>
      <div className="cell-date date">{row.signal_date}</div>
      <div className="cell-conf conf">
        <div className="cbar">
          <span>cf</span>
          <div className="track">
            <div
              className="fill"
              style={{ width: barWidth(row.confidence_score) }}
            />
          </div>
          <span className="v">{row.confidence_score.toFixed(2)}</span>
        </div>
        <div className="cbar">
          <span>fr</span>
          <div className="track">
            <div
              className="fill g"
              style={{ width: barWidth(row.freshness_score) }}
            />
          </div>
          <span className="v">{row.freshness_score.toFixed(2)}</span>
        </div>
      </div>
      <div>
        {row.signal_source_url ? (
          <a
            className="src"
            href={row.signal_source_url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Source ↗<span className="h">{host(row.signal_source_url)}</span>
          </a>
        ) : (
          <span className="nosrc">at runtime</span>
        )}
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg className="g" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg className="g" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M2 6h12" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg className="g" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M8 4v4l2.5 1.5" />
      <circle cx="8" cy="8" r="6" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg className="g" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="6" cy="8" r="3" />
      <path d="M9 8h5M12 8v2.5" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg className="g" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.5v3.5M8 5.2v.2" />
    </svg>
  );
}
