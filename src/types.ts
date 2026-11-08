export type ExaSearchType = "auto" | "keyword" | "neural" | "fast" | "deep";

export type SignalSummary = {
  company_name: string;
  signal_type: string;
  signal_summary: string;
  signal_date: string;
  /** Pre-screen answers from the signal summary (see buildSignalSchema). */
  company_scale_guess?: string;
  prescreen?: Record<string, string>;
};

export type CompanySummary = {
  description?: string;
  industry?: string;
  employee_estimate?: number | string;
  is_public_or_enterprise?: boolean;
  hq?: string;
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
