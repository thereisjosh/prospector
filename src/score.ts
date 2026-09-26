import { ENTERPRISE_DENYLIST } from "./config.js";
import {
  companyFitChecks,
  nameMatchesSignal,
  netNew,
  normalizeName,
} from "./eval.js";
import type {
  CompanySummary,
  ExaResult,
  IcpConfig,
  ProspectRow,
  SignalSummary,
} from "./types.js";

export type Candidate = {
  result: ExaResult;
  summary: SignalSummary;
  company?: CompanyEnrichment;
};

export type CompanyEnrichment = {
  result?: ExaResult;
  summary: CompanySummary;
};

const SIGNAL_WEIGHTS: Array<[RegExp, number]> = [
  [
    /\b(opening|opened|new|launch|announced).{0,40}\b(warehouse|facility|fulfillment|dc|distribution|center)\b/i,
    0.96,
  ],
  [/\b(funding|funded|series [abc]|raises?|investment)\b/i, 0.95],
  [/\b(embedded payments|payments launch|billing|monetization|reconciliation|revenue operations|revops)\b/i, 0.92],
  [/\b(first|founding).{0,24}\b(ops|operations|revops|revenue operations|business operations)\b/i, 0.93],
  [/\b(hiring wave|multiple roles|add \d+|expanding|expansion|scale|scaling)\b/i, 0.9],
  [/\b(operations manager|senior operations manager|vp.?ops|head of operations)\b/i, 0.78],
  [/\b(growth|volume|ramp|network)\b/i, 0.7],
];

const FIRMOGRAPHIC_TERMS = [
  "3pl",
  "logistics",
  "fulfillment",
  "warehouse",
  "warehousing",
  "freight",
  "supply chain",
  "transportation",
  "last-mile",
  "distribution",
];

const EXCLUDED_COMPANIES = new Set([
  "amazon",
  "chewy",
  "gxo logistics",
  "gxo",
  "keurig dr pepper",
  "kdp",
  "ihirelogistics",
  "quince",
  "emiza",
  "symbotic",
  "a p moller maersk",
  "maersk",
  "medvantx",
  "parts town",
  "parts town unlimited",
  "rsa properties and camco chemical",
  "camco chemical",
  "the wonderful company",
  "weee",
  "tractor supply",
  "tractor supply company",
  "jingdong logistics",
  "jd logistics",
  "sansone group",
  "shein",
  "cj logistics",
  "cj logistics and kobc",
  "averitt",
  "rockefeller group",
  "bertelsmann",
  "qe dynamics",
  "qe dynamics llc",
  "qedynamics",
  "seko logistics",
  "spreetail",
  "flexport",
  "diakon",
  "fcp euro",
  ...ENTERPRISE_DENYLIST.map((name) => normalizeName(name)),
]);

const ENTERPRISE_TERMS = [
  "global leader",
  "fortune 500",
  "publicly traded",
  "multinational",
  "mega cap",
];

const NON_OPERATOR_TERMS = [
  "consumer brand",
  "retail brand",
  "retailer",
  "consumer services",
  "beverage",
  "cpg",
  "coffee",
  "pharmaceutical",
  "pharmacy",
  "healthcare",
  "medical",
  "chemical",
  "manufacturer",
  "restaurant equipment",
  "replacement parts",
  "auto parts",
  "car parts",
  "real estate",
  "property",
  "developer",
  "grocery",
  "marketplace",
  "e-commerce grocery",
  "robotics",
  "automation technology",
  "software",
  "platform",
  "systems integrator",
  "apparel",
  "retail",
  "retail distribution",
  "safety equipment",
  "industrial supplies",
];

const PAYMENTS_COMPANY_TERMS = [
  "payment processor",
  "payments infrastructure",
  "payment service provider",
  "psp",
  "merchant acquirer",
  "acquiring bank",
  "card issuing",
  "stripe",
  "adyen",
  "checkout.com",
  "worldpay",
  "paypal",
  "payments platform",
  "payment technology",
  "billing platform",
  "billing and invoicing platform",
  "revenue automation",
  "order-to-revenue automation",
  "accounts receivable automation",
  "tax compliance platform",
  "invoice platform",
  "invoicing platform",
  "billtrust",
  "ordway",
  "zenskar",
  "zoiko",
  "highradius",
  "alacriti",
  "numeral",
];

const B2B_SAAS_TERMS = [
  "b2b",
  "saas",
  "software",
  "marketplace",
  "platform",
  "vertical software",
  "enterprise software",
  "business software",
];

const FIRST_OPS_TERMS = [
  "first revops",
  "first revenue operations",
  "first operations",
  "founding revops",
  "founding operations",
  "first bizops",
  "founding business operations",
  "first business operations",
];

const OPS_ROLE_TERMS = [
  "revops",
  "revenue operations",
  "business operations",
  "bizops",
  "operations lead",
  "head of operations",
  "operations manager",
  "operations associate",
  "operations generalist",
  "chief of staff",
];

export function parseSignalSummary(
  summary: ExaResult["summary"],
  fallback: ExaResult,
): SignalSummary {
  if (
    typeof summary === "object" &&
    summary &&
    ("company_name" in summary || "signal_summary" in summary)
  ) {
    return summary as SignalSummary;
  }
  if (typeof summary === "string") {
    const trimmed = summary.trim();
    try {
      const parsed = JSON.parse(trimmed) as Partial<SignalSummary>;
      if (parsed.company_name || parsed.signal_summary) {
        return {
          company_name: parsed.company_name ?? extractCompanyName(fallback),
          signal_type: parsed.signal_type ?? "operations scaling",
          signal_summary: parsed.signal_summary ?? trimmed,
          signal_date: parsed.signal_date ?? fallback.publishedDate ?? "",
        };
      }
    } catch {
      // Exa may fall back to prose summaries; keep the row and score it lower.
    }
    return {
      company_name: extractCompanyName(fallback),
      signal_type: "operations scaling",
      signal_summary: trimmed,
      signal_date: fallback.publishedDate ?? "",
    };
  }
  return {
    company_name: extractCompanyName(fallback),
    signal_type: "operations scaling",
    signal_summary: fallback.title ?? "Recent logistics operations signal",
    signal_date: fallback.publishedDate ?? "",
  };
}

export function selectCompaniesForEnrichment(
  icp: IcpConfig,
  candidates: Candidate[],
  startIso: string,
  now = new Date(),
  limit = 20,
): string[] {
  return aggregateCandidates(icp, candidates, startIso, now)
    .sort((a, b) => preliminaryScore(icp, b, startIso, now) - preliminaryScore(icp, a, startIso, now))
    .slice(0, limit)
    .map((group) => group.company);
}

export function scoreAndRank(
  icp: IcpConfig,
  candidates: Candidate[],
  startIso: string,
  now = new Date(),
): ProspectRow[] {
  return aggregateCandidates(icp, candidates, startIso, now)
    .map((group) => toRow(icp, group, startIso, now))
    .filter((row): row is ProspectRow => Boolean(row))
    .sort((a, b) => {
      const bScore = b.confidence_score * 0.75 + b.freshness_score * 0.25;
      const aScore = a.confidence_score * 0.75 + a.freshness_score * 0.25;
      return bScore - aScore;
    })
    .slice(0, 15);
}

type CandidateGroup = {
  company: string;
  candidates: Candidate[];
  companyEnrichment?: CompanyEnrichment;
};

function aggregateCandidates(
  icp: IcpConfig,
  candidates: Candidate[],
  startIso: string,
  now: Date,
): CandidateGroup[] {
  const groups = new Map<string, CandidateGroup>();

  for (const candidate of candidates) {
    if (isRejectedSourceUrl(candidate.result.url)) continue;

    const company = cleanCompanyName(
      candidate.summary.company_name || extractCompanyName(candidate.result),
    );
    if (!company) continue;

    const signalDate = normalizeDate(
      candidate.summary.signal_date || candidate.result.publishedDate,
    );
    if (freshnessScore(signalDate, startIso, now) <= 0) continue;

    const key = normalizeName(company);
    if (!key || (icp.id === 1 && EXCLUDED_COMPANIES.has(key))) continue;

    const group = groups.get(key) ?? { company, candidates: [] };
    group.candidates.push(candidate);
    group.companyEnrichment ??= candidate.company;
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const byUrl = new Map<string, Candidate>();
    for (const candidate of group.candidates) {
      const existing = byUrl.get(candidate.result.url);
      if (!existing || candidateScore(candidate) > candidateScore(existing)) {
        byUrl.set(candidate.result.url, candidate);
      }
    }
    group.candidates = [...byUrl.values()];
  }

  return [...groups.values()];
}

function toRow(
  icp: IcpConfig,
  group: CandidateGroup,
  startIso: string,
  now: Date,
): ProspectRow | undefined {
  const best = bestCandidateForIcp(icp, group.candidates);
  if (!best) return undefined;

  const { result, summary } = best;
  const signalDate = normalizeDate(summary.signal_date || result.publishedDate);
  const allText = [
    result.title,
    result.text,
    result.highlights?.join(" "),
    summary.signal_type,
    summary.signal_summary,
  ]
    .filter(Boolean)
    .join(" ");
  const groupSourceText = group.candidates
    .map((candidate) =>
      [
        candidate.result.title,
        candidate.result.text,
        candidate.result.highlights?.join(" "),
        candidate.summary.signal_summary,
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join(" ");
  const company = group.company;
  const companyText = companyProfileText(group.companyEnrichment);
  const fit = firmographicFit(
    icp,
    company,
    companyText || allText,
    groupSourceText,
    group.companyEnrichment,
  );
  if (!fit.keep) return undefined;
  if (icp.id === 2 && !hasPaymentsBillingSignal(groupSourceText)) {
    return undefined;
  }

  const aggregateCount = distinctSignalCount(group.candidates);
  const signalStrength = signalScore(icp, `${allText} ${groupSourceText} ${companyText}`, aggregateCount);
  if (isWeakWhyNow(summary.signal_summary) && (aggregateCount < 2 || icp.id === 3)) return undefined;
  if (
    icp.id === 3 &&
    !hasFundingSignal(`${groupSourceText} ${companyText}`)
  ) {
    return undefined;
  }
  const wrongCompanyPenalty = nameMatchesSignal({
    company,
    title: result.title,
    text: [result.text, result.highlights?.join(" ")].filter(Boolean).join(" "),
    summary: summary.signal_summary,
  })
    ? 1
    : 0.72;
  const confidence = clamp(fit.multiplier * signalStrength.score * wrongCompanyPenalty);
  const whyNow =
    isWeakWhyNow(summary.signal_summary) && aggregateCount >= 2
      ? `${company} has ${aggregateCount} distinct recent operations or last-mile hiring signals; strongest dated source is ${result.title ?? result.url}.`
      : summary.signal_summary || result.title || "";

  return {
    company,
    one_liner: oneLiner(icp, company, allText),
    fit_reason: fit.reason,
    why_now_signal: whyNow,
    signal_strength: signalStrength.label,
    signal_source_url: result.url,
    signal_date: signalDate,
    confidence_score: round(confidence),
    freshness_score: round(freshnessScore(signalDate, startIso, now)),
    net_new: netNew(company, icp.baseline),
  };
}

function isWeakWhyNow(value: string | undefined): boolean {
  return /no explicit why-now signal|not explicitly stated|not explicitly provided|cannot be determined|not determinable|does not provide|no explicit why-now|\bnull\b|not provided on the page/i.test(value ?? "");
}

function preliminaryScore(
  icp: IcpConfig,
  group: CandidateGroup,
  startIso: string,
  now: Date,
): number {
  const best = bestCandidate(group.candidates);
  if (!best) return 0;
  const allText = [
    ...group.candidates.flatMap((candidate) => [
      candidate.result.title,
      candidate.result.text,
      candidate.result.highlights?.join(" "),
      candidate.summary.signal_type,
      candidate.summary.signal_summary,
    ]),
  ]
    .filter(Boolean)
    .join(" ");
  const fitHint = preliminaryFitHint(icp, allText, group.company);
  return (
    signalScore(icp, allText, distinctSignalCount(group.candidates)).score * 0.65 +
    freshnessScore(
      normalizeDate(best.summary.signal_date || best.result.publishedDate),
      startIso,
      now,
    ) *
      0.2 +
    fitHint +
    (icp.id === 3 && hasFundingAndOpsSignal(allText, "") ? 0.12 : 0)
  );
}

function preliminaryFitHint(
  icp: IcpConfig,
  text: string,
  company: string,
): number {
  const normalized = normalizeName(`${company} ${text}`);
  if (icp.id === 1) {
    if (EXCLUDED_COMPANIES.has(normalizeName(company))) return -1;
    const logistics = FIRMOGRAPHIC_TERMS.some((term) =>
      normalized.includes(normalizeName(term)),
    );
    const nonOperator = NON_OPERATOR_TERMS.some((term) =>
      normalized.includes(normalizeName(term)),
    );
    return (logistics ? 0.18 : 0) + (nonOperator ? -0.2 : 0);
  }
  if (icp.id === 2) {
    const paymentSignal = hasPaymentsBillingSignal(text);
    const psp = PAYMENTS_COMPANY_TERMS.some((term) =>
      normalized.includes(normalizeName(term)),
    );
    const b2bSoftware = B2B_SAAS_TERMS.some((term) =>
      normalized.includes(normalizeName(term)),
    );
    return (paymentSignal ? 0.18 : -0.25) + (b2bSoftware ? 0.08 : 0) + (psp ? -0.35 : 0);
  }
  if (icp.id === 3) {
    return hasFundingSignal(text) ? 0.2 : -0.35;
  }
  return 0;
}

function bestCandidate(candidates: Candidate[]): Candidate | undefined {
  return [...candidates].sort((a, b) => candidateScore(b) - candidateScore(a))[0];
}

function bestCandidateForIcp(
  icp: IcpConfig,
  candidates: Candidate[],
): Candidate | undefined {
  if (icp.id === 3) {
    const fundingCandidates = candidates.filter((candidate) =>
      hasFundingSignal(
        [
          candidate.result.title,
          candidate.result.text,
          candidate.result.highlights?.join(" "),
          candidate.summary.signal_type,
          candidate.summary.signal_summary,
        ]
          .filter(Boolean)
          .join(" "),
      ),
    );
    if (fundingCandidates.length > 0) return bestCandidate(fundingCandidates);
  }
  return bestCandidate(candidates);
}

function candidateScore(candidate: Candidate): number {
  const text = [
    candidate.result.title,
    candidate.result.text,
    candidate.result.highlights?.join(" "),
    candidate.summary.signal_type,
    candidate.summary.signal_summary,
  ]
    .filter(Boolean)
    .join(" ");
  return signalScore({ id: 1 } as IcpConfig, text, 1).score + (candidate.result.score ?? 0) / 100;
}

function extractCompanyName(result: ExaResult): string {
  const title = result.title ?? "";
  const patterns = [
    /\bat\s+([^|@–—-]+)/i,
    /^([^|@–—-]+?)\s+(?:to|opens|opening|hiring|adds|expands)\b/i,
    /^([^|@–—-]+?)\s*[@|]/i,
  ];
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match?.[1]) return cleanCompanyName(match[1]);
  }
  return title.split(/[|–—-]/)[0]?.trim() || new URL(result.url).hostname;
}

function cleanCompanyName(value: string): string {
  return value
    .replace(/^company:\s*/i, "")
    .replace(/\s+(jobs?|careers?|job board)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firmographicFit(
  icp: IcpConfig,
  company: string,
  text: string,
  signalText: string,
  enrichment: CompanyEnrichment | undefined,
): { keep: boolean; multiplier: number; reason: string } {
  const normalized = text.toLowerCase();
  const employeeEstimate = parseEmployeeEstimate(
    enrichment?.summary.employee_estimate,
  );
  const enterprise = isEnterpriseCompany(company, normalized, enrichment);
  const hq = enrichment?.summary.hq ?? "";
  if (!hqInAllowedCountries(hq, icp.allowedHqCountries) && !textInAllowedCountries(signalText, icp.allowedHqCountries)) {
    return {
      keep: false,
      multiplier: 0,
      reason: `Excluded: HQ "${hq || "unknown"}" is outside ${icp.allowedHqCountries.join("/")}.`,
    };
  }

  if (employeeEstimate === undefined) {
    if (icp.employeeRange.unknownPolicy === "reject" || enterprise) {
      return {
        keep: false,
        multiplier: 0,
        reason: `Excluded: employee estimate unknown${enterprise ? " and company appears public/enterprise scale" : ""}.`,
      };
    }
  } else if (
    employeeEstimate < icp.employeeRange.min ||
    employeeEstimate > icp.employeeRange.max
  ) {
    return {
      keep: false,
      multiplier: 0,
      reason: `Excluded: employee estimate ${employeeEstimate.toLocaleString()} is outside the approximate ${icp.employeeRange.min}-${icp.employeeRange.max} target.`,
    };
  }

  if (enterprise && employeeEstimate === undefined) {
    return {
      keep: false,
      multiplier: 0,
      reason: "Excluded: known public/enterprise company with unknown employee estimate.",
    };
  }

  if (icp.id === 2) {
    return icp2Fit(company, normalized, enrichment, employeeEstimate);
  }

  if (icp.id === 3) {
    return icp3Fit(company, normalized, signalText, enrichment, employeeEstimate);
  }

  const checks = companyFitChecks({
    icp,
    company,
    description: normalized,
    industry: enrichment?.summary.industry,
    employeeEstimate,
    isThirdPartyLogistics: enrichment?.summary.is_third_party_logistics,
  });

  if (!checks.is_3pl) {
    return {
      keep: false,
      multiplier: 0,
      reason: "Excluded: company lookup did not support logistics/3PL operator fit.",
    };
  }
  if (!enrichment && !hasStrongLogisticsOperatorSignal(`${company} ${text} ${signalText}`)) {
    return {
      keep: false,
      multiplier: 0,
      reason: "Excluded: fallback signal had generic warehouse language without clear logistics/3PL operator fit.",
    };
  }
  if (EXCLUDED_COMPANIES.has(normalizeName(company))) {
    return {
      keep: false,
      multiplier: 0,
      reason: "Excluded: known enterprise, vendor, or non-ICP company.",
    };
  }
  if (
    ENTERPRISE_TERMS.some((term) => normalized.includes(term)) ||
    ENTERPRISE_DENYLIST.some((name) => normalizeName(name) === normalizeName(company))
  ) {
    return {
      keep: false,
      multiplier: 0,
      reason: "Excluded: known enterprise-scale logistics company.",
    };
  }
  if (NON_OPERATOR_TERMS.some((term) => normalized.includes(term))) {
    return {
      keep: false,
      multiplier: 0,
      reason: "Excluded: company appears to be a brand, CPG, software, robotics, or vendor profile.",
    };
  }

  const sizePhrase = employeeEstimate
    ? `${employeeEstimate.toLocaleString()} estimated employees`
    : "company lookup did not expose a precise employee count";
  return {
    keep: true,
    multiplier: employeeEstimate ? 1 : 0.82,
    reason: `${enrichment ? "Company lookup" : "Signal text"} supports logistics/3PL operator fit; ${sizePhrase}; ${enrichment?.summary.hq ?? "HQ inferred from signal/source"}.`,
  };
}

function hasStrongLogisticsOperatorSignal(text: string): boolean {
  return /\b(3pl|third[-\s]party logistics|logistics provider|logistics company|freight|fulfillment|last[-\s]mile|final[-\s]mile|delivery operations|moving and storage|terminal facility|distribution facility|transportation|supply chain)\b/i.test(text);
}

function icp2Fit(
  company: string,
  normalized: string,
  enrichment: CompanyEnrichment | undefined,
  employeeEstimate: number | undefined,
): { keep: boolean; multiplier: number; reason: string } {
  if (
    enrichment?.summary.is_payments_company_or_psp === true ||
    PAYMENTS_COMPANY_TERMS.some((term) => normalized.includes(term))
  ) {
    return {
      keep: false,
      multiplier: 0,
      reason: "Excluded: company appears to be a payments company, processor, or PSP.",
    };
  }
  const b2bSaas =
    enrichment?.summary.is_b2b_saas_or_marketplace === true ||
    B2B_SAAS_TERMS.some((term) => normalized.includes(term));
  if (!b2bSaas) {
    return {
      keep: false,
      multiplier: 0,
      reason: "Excluded: company lookup did not support B2B SaaS/marketplace fit.",
    };
  }
  return {
    keep: true,
    multiplier: 1,
    reason: `${enrichment ? "Company lookup" : "Signal text"} supports B2B SaaS/marketplace fit; ${employeeEstimate ? `${employeeEstimate.toLocaleString()} estimated employees` : "company lookup did not expose a precise employee count"}; ${enrichment?.summary.hq ?? "HQ inferred from signal/source"}.`,
  };
}

function icp3Fit(
  company: string,
  normalized: string,
  signalText: string,
  enrichment: CompanyEnrichment | undefined,
  employeeEstimate: number | undefined,
): { keep: boolean; multiplier: number; reason: string } {
  const b2b =
    enrichment?.summary.is_b2b_company === true ||
    B2B_SAAS_TERMS.some((term) => normalized.includes(term));
  if (!b2b) {
    return {
      keep: false,
      multiplier: 0,
      reason: "Excluded: company lookup did not support B2B company fit.",
    };
  }
  if (!hasFundingSignal(`${signalText} ${normalized}`)) {
    return {
      keep: false,
      multiplier: 0,
      reason: "Excluded: missing recent seed or Series A funding signal.",
    };
  }
  const opsSignal = hasOpsHiringSignal(signalText) || enrichment?.summary.hiring_first_ops_or_revops === true;
  return {
    keep: true,
    multiplier: opsSignal ? 1 : 0.82,
    reason: `${enrichment ? "Company lookup" : "Signal text"} supports recently funded B2B fit${opsSignal ? " plus Ops/RevOps hiring evidence" : ""}; ${employeeEstimate ? `${employeeEstimate.toLocaleString()} estimated employees` : "company lookup did not expose a precise employee count"}; ${enrichment?.summary.hq ?? "HQ inferred from signal/source"}.`,
  };
}

function signalScore(
  icp: Pick<IcpConfig, "id">,
  text: string,
  aggregateCount: number,
): { score: number; label: string } {
  if (icp.id === 2) {
    if (/\b(embedded payments|payment launch|payments launch|launched payments|expanded payments|billing feature|usage-based billing|usage based billing|monetization|monetisation|reconciliation|wallets?|stored-value|stored value)\b/i.test(text)) {
      return { score: 0.94, label: "payments/billing launch" };
    }
    if (/\b(billing operations|billing ops|revenue operations|revops|finance operations|finance ops|order-to-cash|o2c|accounts receivable|invoic(?:e|ing))\b/i.test(text)) {
      return { score: 0.87, label: "billing/revenue-ops hire" };
    }
    if (hasPaymentsBillingSignal(text)) {
      return { score: 0.72, label: "single payments/billing mention" };
    }
  }

  if (icp.id === 3) {
    const funding = hasFundingSignal(text);
    const firstOps = hasFirstOpsText(text);
    const ops = hasOpsHiringSignal(text);
    if (funding && firstOps) return { score: 0.96, label: "funding + first-ops hire" };
    if (funding && ops) return { score: 0.9, label: "funding + ops hire" };
    if (funding) return { score: 0.78, label: "funding only" };
  }

  for (const [pattern, weight] of SIGNAL_WEIGHTS) {
    if (pattern.test(text)) {
      if (/\b(first|founding).{0,24}\b(ops|operations|revops|revenue operations|business operations)\b/i.test(text)) {
        return { score: weight, label: "first-ops/revops hire" };
      }
      if (/\b(funding|funded|series [abc]|raises?|investment|opening|opened|new|launch|announced)\b/i.test(text)) {
        return { score: weight, label: "new-facility/expansion/funding" };
      }
      if (aggregateCount >= 2) {
        return {
          score: Math.min(0.93, weight + 0.08),
          label: `multi-post hiring wave (${aggregateCount} signals)`,
        };
      }
      return { score: weight, label: "single operations signal" };
    }
  }
  if (aggregateCount >= 2) {
    return { score: 0.82, label: `multi-post hiring wave (${aggregateCount} signals)` };
  }
  return { score: 0.55, label: "single weak signal" };
}

function freshnessScore(value: string, startIso: string, now: Date): number {
  const signal = new Date(value).getTime();
  const start = new Date(startIso).getTime();
  const end = now.getTime();
  if (!Number.isFinite(signal) || signal < start || signal > end) return 0;
  return clamp((signal - start) / (end - start));
}

function normalizeDate(value: string | undefined): string {
  if (!value || value === "null") return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value.slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function safeDomain(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function dedupeKey(url: string, companyKey: string): string {
  const domain = safeDomain(url) ?? companyKey;
  return isAggregatorDomain(domain) ? `${domain}:${companyKey}` : domain;
}

function distinctSignalCount(candidates: Candidate[]): number {
  return new Set(candidates.map((candidate) => dedupeKey(candidate.result.url, normalizeName(candidate.summary.company_name)))).size;
}

function companyProfileText(enrichment: CompanyEnrichment | undefined): string {
  if (!enrichment) return "";
  return [
    enrichment.summary.description,
    enrichment.summary.industry,
    enrichment.summary.hq,
    enrichment.result?.title,
    enrichment.result?.text,
    enrichment.result?.entities?.map((entity) => entity.name).join(" "),
  ]
    .filter(Boolean)
    .join(" ");
}

function isEnterpriseCompany(
  company: string,
  normalizedText: string,
  enrichment: CompanyEnrichment | undefined,
): boolean {
  const companyKey = normalizeName(company);
  return (
    enrichment?.summary.is_public_or_enterprise === true ||
    ENTERPRISE_DENYLIST.some((name) => normalizeName(name) === companyKey) ||
    ENTERPRISE_TERMS.some((term) => normalizedText.includes(term))
  );
}

function hqInAllowedCountries(hq: string, allowed: readonly string[]): boolean {
  const normalized = normalizeName(hq);
  if (!normalized) return false;
  const us = /\b(united states|usa|u s|us|alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|illinois|massachusetts|new york|texas|washington|ohio|michigan|pennsylvania|north carolina|south carolina|tennessee|utah|virginia|wisconsin|minnesota|missouri|indiana|iowa|nevada|oregon|new jersey|maryland|dc|al|ak|az|ar|ca|co|ct|de|fl|ga|il|ma|ny|tx|wa|oh|mi|pa|nc|sc|tn|ut|va|wi|mn|mo|in|ia|nv|or|nj|md)\b/.test(normalized);
  const uk = /\b(united kingdom|uk|england|scotland|wales|london|manchester|birmingham|bristol)\b/.test(normalized);
  return (allowed.includes("US") && us) || (allowed.includes("UK") && uk);
}

function textInAllowedCountries(text: string, allowed: readonly string[]): boolean {
  const normalized = normalizeName(text);
  const us = /\b(united states|usa|alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|illinois|massachusetts|new york|texas|washington|ohio|michigan|pennsylvania|north carolina|south carolina|tennessee|utah|virginia|wisconsin|minnesota|missouri|indiana|iowa|nevada|oregon|new jersey|maryland|colorado springs|long island city|albany|wichita|kansas|kentucky|michigan|las vegas|boone county)\b/.test(normalized);
  const uk = /\b(united kingdom|england|scotland|wales|london|manchester|birmingham|bristol)\b/.test(normalized);
  return (allowed.includes("US") && us) || (allowed.includes("UK") && uk);
}

function hasFundingAndOpsSignal(signalText: string, companyText: string): boolean {
  const text = `${signalText} ${companyText}`
    .toLowerCase()
    .replace(/first operations\/revops hire signal requested/g, "")
    .replace(/first operations\/revops-related expansion/g, "")
    .replace(/recent seed or series a funding signal and first operations\/revops hire signal/g, "");
  return hasFundingSignal(text) && hasOpsHiringSignal(text);
}

function hasFundingSignal(text: string): boolean {
  return /\b(seed|series a|pre-seed|raised|raises|funding|funded|financing|investment)\b/i.test(text);
}

function hasFirstOpsText(text: string): boolean {
  const normalized = text.toLowerCase();
  if (/requested|not explicitly|not provided|null|not determinable|cannot be determined/.test(normalized)) {
    return false;
  }
  return (
    FIRST_OPS_TERMS.some((term) => normalized.includes(term)) ||
    (/\b(first|founding|founder-led)\b/.test(normalized) &&
      OPS_ROLE_TERMS.some((term) => normalized.includes(term))) ||
    /\b(first|founding).{0,36}\b(ops|operations|revops|revenue operations|business operations|bizops)\b/.test(normalized)
  );
}

function hasOpsHiringSignal(text: string): boolean {
  const normalized = text.toLowerCase();
  if (/requested|not explicitly|not provided|null|not determinable|cannot be determined/.test(normalized)) {
    return false;
  }
  const hasOpsRole = OPS_ROLE_TERMS.some((term) => normalized.includes(term));
  const hasHiringToken = /\b(hiring|hire|role|job|career|opening|position|recruiting|posted|seeking|join our team)\b/.test(normalized);
  return hasOpsRole && hasHiringToken;
}

function hasPaymentsBillingSignal(text: string): boolean {
  return /\b(embedded payments|payment launch|payments launch|launched payments|expanded payments|billing operations|billing ops|billing platform|billing feature|usage-based billing|usage based pricing|subscription billing|prepaid credit|wallets?|stored-value|stored value|revenue automation|revenue operations|revops|finance operations|finance ops|monetization|monetisation|reconciliation|order-to-cash|o2c|accounts receivable|invoice|invoicing)\b/i.test(text);
}

export function parseEmployeeEstimate(value: CompanySummary["employee_estimate"]): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;

  const normalized = value.toLowerCase().replace(/,/g, "");
  const range = normalized.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (range?.[1] && range[2]) {
    return Math.round((Number(range[1]) + Number(range[2])) / 2);
  }

  const plus = normalized.match(/(\d+)\s*\+/);
  if (plus?.[1]) return Number(plus[1]);

  const number = normalized.match(/\d+/);
  return number ? Number(number[0]) : undefined;
}

function isAggregatorDomain(domain: string): boolean {
  return [
    "greenhouse.io",
    "smartrecruiters.com",
    "energyjobline.com",
    "themuse.com",
    "ihirelogistics.com",
    "venturefizz.com",
    "emploive.com",
    "zerogtalent.com",
  ].some((aggregator) => domain === aggregator || domain.endsWith(`.${aggregator}`));
}

function isRejectedSourceUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "exa.ai" && parsed.pathname.startsWith("/library/person/");
  } catch {
    return false;
  }
}

function oneLiner(icp: IcpConfig, company: string, text: string): string {
  if (icp.id === 2) {
    return `${company} shows a recent payments, billing, or revenue-operations signal.`;
  }
  if (icp.id === 3) {
    return `${company} shows recent funding plus a first Ops/RevOps hiring signal.`;
  }
  const descriptor = FIRMOGRAPHIC_TERMS.find((term) =>
    text.toLowerCase().includes(term),
  );
  return descriptor
    ? `${company} shows a recent ${descriptor} operations-scaling signal.`
    : `${company} shows a recent operations-scaling signal.`;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
