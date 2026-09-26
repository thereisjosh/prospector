export type ExaSearchType = "auto" | "keyword" | "neural" | "fast" | "deep";

export type SignalSummary = {
  company_name: string;
  signal_type: string;
  signal_summary: string;
  signal_date: string;
};

export type CompanySummary = {
  description?: string;
  industry?: string;
  employee_estimate?: number | string;
  is_third_party_logistics?: boolean;
  is_b2b_saas_or_marketplace?: boolean;
  is_payments_company_or_psp?: boolean;
  is_b2b_company?: boolean;
  recently_funded_seed_or_series_a?: boolean;
  hiring_first_ops_or_revops?: boolean;
  is_public_or_enterprise?: boolean;
  hq?: string;
};

export type IcpId = 1 | 2 | 3;

export type IcpConfig = {
  id: IcpId;
  name: string;
  months: number;
  employeeRange: {
    min: number;
    max: number;
    unknownPolicy: "allow-if-not-enterprise" | "reject";
  };
  allowedHqCountries: string[];
  signalQueries: string[];
  summaryQuery: string;
  companySummaryQuery: string;
  baseline: readonly string[];
  enrichmentLimit: number;
};

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
  confidence_score: number;
  freshness_score: number;
  net_new: boolean;
};
