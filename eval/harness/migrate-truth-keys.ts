/**
 * One-off: rename every truth file (and its .prev.json) to the CURRENT key
 * (squashName(company) + "__" + sha1(signal_url)[:10]). squashName has changed since
 * some verdicts were written ("avarraai__x" is now "avarra__x"). Idempotent.
 *
 *   npx tsx eval/harness/migrate-truth-keys.ts [truthRoot]
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { truthKey } from "./truth";

export type Rename = { from: string; to: string; status: "renamed" | "conflict" };

export function migrateTruthKeys(truthRoot = "eval/truth"): Rename[] {
  const out: Rename[] = [];
  if (!existsSync(truthRoot)) return out;
  for (const scenario of readdirSync(truthRoot)) {
    const dir = join(truthRoot, scenario);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const prev = name.endsWith(".prev.json");
      let stored: { company?: unknown; signal_url?: unknown };
      try {
        stored = JSON.parse(readFileSync(join(dir, name), "utf8")) as typeof stored;
      } catch {
        continue;
      }
      if (typeof stored.company !== "string" || typeof stored.signal_url !== "string") continue;
      const target = `${truthKey(stored.company, stored.signal_url)}${prev ? ".prev.json" : ".json"}`;
      if (target === name) continue;
      if (existsSync(join(dir, target))) {
        out.push({ from: join(dir, name), to: join(dir, target), status: "conflict" });
        continue;
      }
      renameSync(join(dir, name), join(dir, target));
      out.push({ from: join(dir, name), to: join(dir, target), status: "renamed" });
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const renames = migrateTruthKeys(process.argv[2]);
  for (const r of renames) console.log(`${r.status}: ${r.from} -> ${r.to}`);
  console.log(`${renames.filter((r) => r.status === "renamed").length} renamed, ${renames.filter((r) => r.status === "conflict").length} conflicts`);
}
