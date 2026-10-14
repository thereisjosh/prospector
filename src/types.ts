export type ExaSearchType = "auto" | "keyword" | "neural" | "fast" | "deep";

export type SignalSummary = {
  company_name: string;
  signal_type: string;
  signal_summary: string;
  signal_date: string;
  /** Verbatim sentence from the page stating the event, or "" when not stated. */
  signal_quote?: string;
  /** Verbatim date phrase from the page, or "" when not stated. */
  signal_date_quote?: string;
};

export type CompanySummary = {
  description?: string;
  industry?: string;
  employee_estimate?: number | string;
  /** Quoted phrase the employee estimate came from, or "". */
  employee_estimate_source?: string;
  is_public_or_enterprise?: boolean;
  hq?: string;
  /** Verbatim phrase from the lookup page stating HQ, or "". */
  hq_quote?: string;
  /** ≤ 1,500 chars of the lookup page text Exa summarised. */
  source_excerpt?: string;
  /** True when the lookup page text hit the request's maxCharacters, so quotes beyond it cannot be verified. */
  lookup_text_truncated?: boolean;
  /** Plan-generated boolean gates (see SearchPlan.gateFields). */
  [gateKey: string]: unknown;
};

export type IcpId = 1 | 2 | 3;

export type ExaCostDollars = {
  total?: number;
  [key: string]: unknown;
};

export type ExaResult = {
  id?: string;
  title?: string;
  url: string;
  publishedDate?: string;
  author?: string;
  score?: number;
  text?: string;
  highlights?: string[];
  summary?: string | SignalSummary | CompanySummary;
  entities?: Array<{
    name?: string;
    type?: string;
    [key: string]: unknown;
  }>;
};

export type ExaSearchResponse = {
  requestId?: string;
  resolvedSearchType?: string;
  results: ExaResult[];
  searchTime?: number;
  costDollars?: ExaCostDollars;
};

export type ProspectRow = {
  company: string;
  one_liner: string;
  fit_reason: string;
  why_now_signal: string;
  signal_strength: string;
  signal_source_url: string;
  signal_date: string;
  /** "signal" = the model's event date was plausible; "published_fallback" = it was not, so publishedDate was used. */
  date_source?: "signal" | "published_fallback";
  confidence_score: number;
  freshness_score: number;
  net_new: boolean;
};
