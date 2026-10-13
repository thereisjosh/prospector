/**
 * Generic HQ-country matching for SearchPlan.hqCountries (ISO-2 codes).
 * Exa returns HQ as free text ("Austin, TX, United States"), so we match on
 * country names/aliases, and for the US also on state names / abbreviations.
 */

const COUNTRY_ALIASES: Record<string, string[]> = {
  US: ["united states", "united states of america", "usa", "u s a", "u s"],
  GB: ["united kingdom", "uk", "u k", "great britain", "england", "scotland", "wales", "northern ireland", "london", "manchester", "birmingham", "bristol"],
  CA: ["canada", "toronto", "vancouver", "montreal", "ontario", "british columbia", "quebec"],
  AU: ["australia", "sydney", "melbourne", "brisbane"],
  NZ: ["new zealand", "auckland", "wellington"],
  IE: ["ireland", "dublin"],
  SG: ["singapore"],
  IN: ["india", "mumbai", "bangalore", "bengaluru", "delhi", "hyderabad", "chennai", "pune"],
  DE: ["germany", "berlin", "munich"],
  FR: ["france", "paris"],
  NL: ["netherlands", "amsterdam"],
  ES: ["spain", "madrid", "barcelona"],
  IT: ["italy", "milan", "rome"],
  SE: ["sweden", "stockholm"],
  CH: ["switzerland", "zurich", "geneva"],
  AE: ["united arab emirates", "uae", "dubai", "abu dhabi"],
  HK: ["hong kong"],
  JP: ["japan", "tokyo"],
  KR: ["south korea", "korea", "seoul"],
  CN: ["china", "beijing", "shanghai", "shenzhen"],
  MY: ["malaysia", "kuala lumpur"],
  ID: ["indonesia", "jakarta"],
  PH: ["philippines", "manila"],
  TH: ["thailand", "bangkok"],
  VN: ["vietnam", "ho chi minh", "hanoi"],
  BR: ["brazil", "sao paulo"],
  MX: ["mexico", "mexico city"],
  IL: ["israel", "tel aviv"],
  ZA: ["south africa", "johannesburg", "cape town"],
  NG: ["nigeria", "lagos"],
};

const US_STATE_NAMES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware",
  "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky",
  "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
  "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico",
  "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania",
  "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont",
  "virginia", "washington", "west virginia", "wisconsin", "wyoming", "district of columbia",
];

const US_STATE_ABBREVIATIONS = new Set(
  ("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC").split(" "),
);

function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function hasPhrase(haystack: string, phrase: string): boolean {
  return ` ${haystack} `.includes(` ${phrase} `);
}

/** ISO-2 codes this module knows how to recognise. */
export const COUNTRY_CODES: readonly string[] = Object.keys(COUNTRY_ALIASES);

/**
 * Country from a 2-letter code in a structured HQ string. Only the LAST
 * comma-separated token counts, and never when that token is also a US state
 * code ("San Francisco, CA" is not Canada, "Indianapolis, IN" is not India,
 * "Wilmington, DE" is not Germany) - those resolve to the US. The exception is
 * a non-US region token right before it ("Calgary, AB, CA" is Canada).
 */
function codeFromLastToken(hq: string): string | undefined {
  const tokens = hq.split(",").map((t) => t.trim()).filter(Boolean);
  const last = tokens[tokens.length - 1];
  if (!last || !/^[A-Z]{2}$/.test(last)) return undefined;
  if (US_STATE_ABBREVIATIONS.has(last)) {
    const prev = tokens.length >= 3 ? tokens[tokens.length - 2] : undefined;
    const prevIsForeignRegion = !!prev && /^[A-Z]{2,3}$/.test(prev) && !US_STATE_ABBREVIATIONS.has(prev);
    if (prevIsForeignRegion && COUNTRY_CODES.includes(last)) return last;
    return "US";
  }
  return COUNTRY_CODES.includes(last) ? last : undefined;
}

/** Best-effort country of a free-text HQ string ("Austin, TX", "Calgary, AB, CA", "Berlin, Germany"). */
export function countryOfHq(hq: string): string | undefined {
  const n = norm(hq);
  if (!n) return undefined;
  const fromCode = codeFromLastToken(hq);
  if (fromCode === "US" && /\b(United States|USA)\b/i.test(hq)) return "US";
  // Spelled-out countries and well-known cities win over abbreviations.
  for (const code of COUNTRY_CODES) {
    if ((COUNTRY_ALIASES[code] ?? []).some((alias) => hasPhrase(n, alias))) return code;
  }
  if (US_STATE_NAMES.some((state) => hasPhrase(n, state))) return "US";
  return fromCode;
}

/**
 * Does free text (an HQ string, or - weaker - a signal blurb) place the
 * company in one of `countries`? Empty `countries` means any country, so true.
 * `structuredHq` is for an HQ field: it also understands state/country codes.
 * Prose only matches spelled-out country names and well-known cities.
 */
export function textInCountries(
  text: string,
  countries: readonly string[],
  structuredHq = false,
): boolean {
  if (countries.length === 0) return true;
  const n = norm(text);
  if (!n) return false;
  const codeCountry = structuredHq ? codeFromLastToken(text) : undefined;
  for (const code of countries) {
    if (codeCountry === code) return true;
    if ((COUNTRY_ALIASES[code] ?? []).some((alias) => hasPhrase(n, alias))) return true;
    if (code === "US" && US_STATE_NAMES.some((state) => hasPhrase(n, state))) return true;
  }
  return false;
}

/**
 * Map a country name or code ("Singapore", "uk", "sg", "United States") to its
 * ISO-2 code. Returns undefined when the input is not a recognised country.
 */
export function countryCodeFromName(name: string): string | undefined {
  const trimmed = name.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed) && COUNTRY_CODES.includes(trimmed.toUpperCase())) return trimmed.toUpperCase();
  const n = norm(trimmed);
  if (!n) return undefined;
  for (const code of COUNTRY_CODES) {
    if ((COUNTRY_ALIASES[code] ?? []).includes(n)) return code;
  }
  return undefined;
}
