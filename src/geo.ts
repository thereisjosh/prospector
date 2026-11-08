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

/**
 * Does free text (an HQ string, or - weaker - a signal blurb) place the
 * company in one of `countries`? Empty `countries` means any country, so true.
 * `allowAbbreviations` enables 2-letter US state codes and is meant only for a
 * structured HQ string, not prose.
 */
export function textInCountries(
  text: string,
  countries: readonly string[],
  allowAbbreviations = false,
): boolean {
  if (countries.length === 0) return true;
  const n = norm(text);
  if (!n) return false;
  for (const code of countries) {
    if (allowAbbreviations && hasPhrase(n, code.toLowerCase())) return true;
    for (const alias of COUNTRY_ALIASES[code] ?? []) {
      if (hasPhrase(n, alias)) return true;
    }
    if (code === "US") {
      if (US_STATE_NAMES.some((state) => hasPhrase(n, state))) return true;
      if (allowAbbreviations) {
        const tokens = text.match(/\b[A-Z]{2}\b/g) ?? [];
        if (tokens.some((t) => US_STATE_ABBREVIATIONS.has(t))) return true;
      }
    }
  }
  return false;
}
