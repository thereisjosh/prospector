import { CostGuard, ExaHttpError, type ExaCredentials } from "../exa";

export type ExaContentsResult = {
  title?: string;
  url: string;
  publishedDate?: string;
  text?: string;
  costDollars?: { total?: number };
};

export async function readExaContents(
  url: string,
  credentials: ExaCredentials = {},
  guard?: CostGuard,
): Promise<ExaContentsResult> {
  const estimate = 0.002;
  guard?.reserve(estimate);
  try {
    const baseUrl = (credentials.baseUrl ?? process.env.EXA_BASE_URL ?? "https://api.exa.ai").replace(/\/$/, "");
    const apiKey = credentials.apiKey ?? process.env.EXA_API_KEY;
    if (!apiKey) throw new Error("EXA_API_KEY is required");
    const response = await fetch(`${baseUrl}/contents`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ urls: [url], text: { maxCharacters: 3000 } }),
    });
    const text = await response.text();
    const json = text ? (JSON.parse(text) as { results?: ExaContentsResult[]; costDollars?: { total?: number } }) : {};
    if (!response.ok) throw new ExaHttpError(response.status, text);
    guard?.settle(estimate, json.costDollars?.total);
    return json.results?.[0] ?? { url };
  } catch (error) {
    guard?.settle(estimate, 0);
    throw error;
  }
}
