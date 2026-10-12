import { CostGuard, exaPost, type ExaCredentials } from "../exa";

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
  const json = await exaPost("/contents", { urls: [url], text: { maxCharacters: 3000 } }, credentials, guard) as unknown as { results?: ExaContentsResult[]; costDollars?: { total?: number } };
  const first = json.results?.[0] ?? { url };
  return { ...first, costDollars: first.costDollars ?? json.costDollars };
}
