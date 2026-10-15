#!/usr/bin/env node
// Records the demo walkthrough at 1280 and writes docs/screenshots/walkthrough.gif (≤ 8 MB) plus fresh PNGs.
//
//   npx next build && node scripts/demo-gif.mjs            # starts `next start` with DEMO_MODE=1 on a free port
//   BASE=http://localhost:3000 node scripts/demo-gif.mjs   # or record an already-running demo server
//
// Walk: Describe → Target → Approve → Run (the approval) → Results → Evidence → Memory panel.
// Needs Playwright (resolved from the project, PLAYWRIGHT_DIR, or the npx cache; `npx playwright install chromium`)
// and ffmpeg on PATH. Not a dependency of the app: nothing here ships.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "docs", "screenshots");
const GIF = join(OUT, "walkthrough.gif");
const MAX_BYTES = 8 * 1024 * 1024;
const VIEW = { width: 1280, height: 800 };
/** The API rate-limits per IP; give each browser context its own bucket so a full walk never waits on a 429. */
let bucket = 0;
const ownIp = () => ({ "x-forwarded-for": `10.77.${process.pid % 250}.${(bucket += 1)}` });

function loadPlaywright() {
  const candidates = [ROOT, process.env.PLAYWRIGHT_DIR].filter(Boolean);
  const npx = join(homedir(), ".npm", "_npx");
  if (existsSync(npx)) for (const d of readdirSync(npx)) candidates.push(join(npx, d));
  for (const dir of candidates) {
    try {
      return createRequire(join(dir, "node_modules", "noop.js"))("playwright");
    } catch {
      // try the next place
    }
  }
  throw new Error("Playwright not found. Run `npx playwright@latest install chromium` once, or set PLAYWRIGHT_DIR.");
}

const freePort = () =>
  new Promise((ok, fail) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
    s.on("error", fail);
  });

async function startServer() {
  if (process.env.BASE) return { base: process.env.BASE, stop: () => undefined };
  if (!existsSync(join(ROOT, ".next", "BUILD_ID"))) throw new Error("No production build: run `npx next build` first.");
  const port = await freePort();
  const data = mkdtempSync(join(tmpdir(), "prospector-gif-")); // a fresh workspace store: the demo seeds its memory
  const child = spawn(join(ROOT, "node_modules", ".bin", "next"), ["start", "-p", String(port)], {
    cwd: ROOT,
    env: { ...process.env, DEMO_MODE: "1", DATA_DIR: data },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${base}/api/mode`);
      if ((await r.json()).demo === true) break;
      throw new Error("server is not in demo mode");
    } catch (error) {
      if (String(error).includes("demo mode")) throw error;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return { base, stop: () => { child.kill(); rmSync(data, { recursive: true, force: true }); } };
}

const pause = (page, ms) => page.waitForTimeout(ms);

/** Moves the pointer onto the element first, so the recording shows where the click lands. */
async function press(page, locator, hold = 350) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await pause(page, hold);
  await locator.click();
}

async function walk(page, base) {
  await page.goto(base);
  await page.waitForFunction(() => (document.querySelector("#seller-input")?.value.length ?? 0) > 0);
  await pause(page, 1400);
  // Describe
  await press(page, page.locator(".pr-prompt-go").first());
  const suggest = page.getByRole("button", { name: "Suggest who to target" });
  await suggest.waitFor();
  await pause(page, 1600);
  // Target
  await press(page, suggest);
  const build = page.getByRole("button", { name: "Build the plan" });
  await build.waitFor();
  await pause(page, 900);
  await press(page, page.getByRole("button", { name: "Why this?" }).first());
  await pause(page, 1400);
  // Approve
  await press(page, build);
  const run = page.getByRole("button", { name: "Run agent" });
  await run.waitFor();
  await pause(page, 1800);
  await press(page, run);
  // Run: the approval
  await page.locator(".pr-confirm").waitFor();
  await pause(page, 2200);
  await press(page, page.getByRole("button", { name: "Approve", exact: true }));
  // Run: live, then results
  await page.locator(".pr-outcome").waitFor({ timeout: 120000 });
  await page.evaluate(() => scrollTo({ top: 0 }));
  await pause(page, 2600);
  // Evidence
  const evidence = page.locator(".lrow-evidence [data-slot=trace-collapsible-trigger]").first();
  await press(page, evidence);
  await page.locator(".lrow-evidence [data-testid=evidence]").first().waitFor();
  await page.evaluate(() => document.querySelector(".lrow-evidence")?.scrollIntoView({ block: "center" }));
  await pause(page, 2400);
  // Feedback on a lead, so "Your feedback" appears in memory
  await press(page, page.getByRole("button", { name: "Good lead" }).first());
  await page.locator(".fb-form input").first().fill("Right size, real expansion");
  await press(page, page.locator(".fb-form .ghost-btn").first(), 200);
  await page.locator(".fb-done").first().waitFor();
  await pause(page, 900);
  // Memory panel
  await page.evaluate(() => scrollTo({ top: 0 }));
  const trigger = page.locator(".pr-mem-trigger");
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await press(page, trigger);
  await pause(page, 2800);
}

async function stills(browser, base) {
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: VIEW, colorScheme: scheme, deviceScaleFactor: 1, extraHTTPHeaders: ownIp() });
    const page = await ctx.newPage();
    await page.goto(base);
    await page.waitForFunction(() => (document.querySelector("#seller-input")?.value.length ?? 0) > 0);
    await page.locator(".pr-prompt-go").first().click();
    await page.getByRole("button", { name: "Suggest who to target" }).click();
    await page.getByRole("button", { name: "Build the plan" }).click();
    await page.getByRole("button", { name: "Run agent" }).click();
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await page.locator(".pr-outcome").waitFor({ timeout: 120000 });
    await page.evaluate(() => scrollTo({ top: 0 }));
    await pause(page, 800);
    await page.screenshot({ path: join(OUT, `demo-${scheme}.png`) });
    await ctx.close();
  }
}

/** webm → GIF with a per-clip palette; steps down fps and width until it fits under 8 MB. */
function toGif(video) {
  for (const [fps, width] of [[12, 1280], [10, 1100], [8, 960], [6, 860]]) {
    const filter = `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", video, "-filter_complex", filter, "-loop", "0", GIF], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("ffmpeg failed (is it installed?)");
    const size = statSync(GIF).size;
    console.log(`walkthrough.gif: ${fps} fps, ${width}px wide, ${(size / 1024 / 1024).toFixed(2)} MB`);
    if (size <= MAX_BYTES) return size;
  }
  throw new Error("GIF stays above 8 MB at every setting");
}

const { chromium } = loadPlaywright();
const server = await startServer();
const browser = await chromium.launch();
const videoDir = mkdtempSync(join(tmpdir(), "prospector-video-"));
try {
  const ctx = await browser.newContext({ viewport: VIEW, colorScheme: "light", recordVideo: { dir: videoDir, size: VIEW }, extraHTTPHeaders: ownIp() });
  const page = await ctx.newPage();
  const t0 = Date.now();
  await walk(page, server.base);
  console.log(`walk took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const video = await page.video().path();
  await ctx.close(); // flushes the video
  toGif(video);
  await stills(browser, server.base);
  console.log(`wrote ${GIF}, ${join(OUT, "demo-light.png")}, ${join(OUT, "demo-dark.png")}`);
} finally {
  await browser.close();
  server.stop();
  rmSync(videoDir, { recursive: true, force: true });
}
