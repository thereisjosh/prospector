# Deploy

## Railway

Live deployment: project `prospector`, service `web`, volume mounted at `/data`, public domain https://web-production-2b8f6.up.railway.app.

`/api/health` reports `version: "dev"` on directory deploys (`railway up`), because `RAILWAY_GIT_COMMIT_SHA` is only set for GitHub-connected deploys. Set the version by hand with `railway variables --set APP_VERSION=<sha>`; the health route reads `RAILWAY_GIT_COMMIT_SHA ?? VERCEL_GIT_COMMIT_SHA ?? APP_VERSION ?? "dev"`.

Mount a persistent Railway volume at `/data` and set `DATA_DIR=/data`. The app stores runs in `/data/runs`, anonymous workspace memory and quota in `/data/workspaces`, and the daily spend ledger at `/data/spend-YYYY-MM-DD.json`.

Environment variables:

| Variable | Default | Notes |
|---|---:|---|
| `DATA_DIR` | unset | Set to `/data` on Railway. |
| `RUNS_DIR` | `<DATA_DIR>/runs` or `./runs` | Explicit value wins over `DATA_DIR`. |
| `WORKSPACES_DIR` | `<DATA_DIR>/workspaces` or `./workspaces` | Explicit value wins over `DATA_DIR`. |
| `ANTHROPIC_API_KEY` | unset | Required for live mode. |
| `EXA_API_KEY` | unset | Required for live mode. |
| `ADMIN_TOKEN` | unset | At least 32 random characters. Enables `/api/admin/*`; without it admin routes answer 503. Set the same value on Railway and in GitHub Actions secrets. |
| `DAILY_SPEND_CAP_DOLLARS` | `10` | Global daily live spend cap. |
| `VISITOR_MAX_LIVE_RUNS` | `2` (production: `3`) | Per anonymous workspace live-run allowance. Production decision: 3 runs or $2.50, whichever comes first. |
| `VISITOR_MAX_DOLLARS` | `2.50` | Per anonymous workspace live/planner spend allowance. |
| `DEMO_MODE` | unset | Set `1` to force recorded demo mode. |
| `LIVE_MODE` | unset | Set `off` to pause live mode. |
| `LANGFUSE_PUBLIC_KEY` | unset | Langfuse project key. Tracing is on only when both keys are set; unset = no tracing, identical behaviour. |
| `LANGFUSE_SECRET_KEY` | unset | Langfuse project secret. |
| `LANGFUSE_BASE_URL` | `https://cloud.langfuse.com` | Langfuse region (EU cloud). |
| `LANGFUSE_TRACING_ENVIRONMENT` | `default` | Set `production` on Railway. `eval` for harness runs and backfills, `ci` for CI. |
| `LANGFUSE_PROMPT_LABEL` | `production` | Langfuse prompt label the app fetches (docs/prompts.md). Set `staging` on a staging service to run the staged prompts. |
| `LANGFUSE_PROMPTS` | unset | Set `off` to ignore Langfuse prompts and run the in-repo text (kill switch; tracing is unaffected). |
| `TRACE_HMAC_SECRET` | unset | HMAC key that turns the workspace id into the trace `userId`. Without it traces carry no user. Keep it stable: rotating it splits users. |
| `ONLINE_JUDGE_DAILY_CAP_DOLLARS` | `3` | Daily cap for the managed online judge. `0` turns online judging off. |
| `ONLINE_JUDGE_COST_PER_LEAD_DOLLARS` | `0.34` | Cost per judged lead used to turn the cap into a daily lead count (cap ÷ cost; samples get at most half). $0.34 is the offline fetch judge's measured cost, an upper bound for the three tool-less managed calls (estimated ≤ $0.07 per lead); lower it once Langfuse shows the real evaluator cost. |

Tracing (SPEC-observability §2–§3): every line appended to `runs/<id>/events.jsonl` is also sent to Langfuse, masked, from `src/agent/trace.ts`. Spans are flushed every second; Next.js exits on SIGTERM without waiting, so a redeploy can drop up to about the last second of spans. `npx tsx eval/trace-backfill.ts <run-dir> --environment production` restores a run's missing observations and scores without duplicating the ones Langfuse already has.

Prompts (docs/prompts.md): with the Langfuse keys set, the agent and planner prompts come from Langfuse Prompt Management (label `LANGFUSE_PROMPT_LABEL`), cached in-process for 60 s; promoting a version in Langfuse reaches the service within about a minute, without a deploy. Runs already in flight keep the version they started with. If Langfuse is unreachable on a cold start the service runs the in-repo text, so a deploy must never ship a repo copy that differs from `production`: run `npx tsx eval/langfuse-prompts.ts diff` before deploying (exit 1 = out of sync).

Kill switch: set `DAILY_SPEND_CAP_DOLLARS=0` or `LIVE_MODE=off`. The API behaves as demo-only, `/api/status` reports `{ "mode": "demo", "reason": "paused" }`, and `POST /api/runs/<id>/step` answers 503 `{ "error": "paused" }`, so runs already in flight stop spending too (they continue once live mode is back). `POST /api/admin/pause` with `Authorization: Bearer <ADMIN_TOKEN>` writes `/data/paused`; the hourly online-evals worker calls it when the day's event cost exceeds `DAILY_SPEND_CAP_DOLLARS`. To resume, remove the file from the volume:

```sh
rm /data/paused
```

## Online evals

Design: SPEC-observability §5. With the Langfuse keys set and `LANGFUSE_TRACING_ENVIRONMENT=production`, every finished run gets its code-grader and outcome scores on its last trace, selected leads get a `lead-judge` observation for the managed judges, and handback/error/must-pass-failure/👎 traces go to the `review-queue` annotation queue. Selections are logged in `runs/<id>/online-evals.jsonl`, the judge budget in `/data/online-judge-<UTC date>.json`.

Langfuse side (evaluators `judge_q1..q3`, rule `lead-judge (production)`, score configs, `review-queue`, calibration datasets and prompts) is configuration as code: `npx tsx eval/online/setup-langfuse.ts [--dry-run]` creates or updates it idempotently. The evaluators need an Anthropic LLM connection in Langfuse (Settings → LLM Connections); until one exists they stay paused (`LLM_CONNECTION_MISSING`). The rule is created disabled; enable it with `--enable-rule` only after the judge calibration is approved (`npx tsx eval/online/calibrate-judge.ts`, then `--run --max-dollars <n>`; paid).

Worker: `.github/workflows/online-evals.yml` runs hourly and exports recent production runs through `/api/admin/runs/export`. It needs GitHub repository secrets `ADMIN_TOKEN`, `LANGFUSE_PUBLIC_KEY`, and `LANGFUSE_SECRET_KEY`. It needs repository variable `APP_URL`, plus optional `LANGFUSE_BASE_URL` and `DAILY_SPEND_CAP_DOLLARS`. `ADMIN_TOKEN` must be identical on Railway and in GitHub. Dry run against the live app: `APP_URL=… ADMIN_TOKEN=… GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo npx tsx eval/online/worker.ts --dry-run`.

`GET /api/status?workspaceId=<anonymous-id>` is rate-limited and returns:

```json
{
  "mode": "live",
  "liveAvailable": true,
  "visitor": { "remainingRuns": 2, "remainingDollars": 2.5 },
  "caps": { "perRun": 1, "perRunMax": 5, "visitorRuns": 2, "visitorDollars": 2.5, "daily": 10 },
  "today": { "spentDollars": 0 }
}
```

`GET /api/health` is not rate-limited and returns:

```json
{
  "ok": true,
  "mode": "live",
  "uptimeSec": 123,
  "version": "dev"
}
```

Inspect the global daily ledger on the Railway volume:

```sh
cat /data/spend-$(date -u +%F).json
```

Inspect a visitor quota file:

```sh
cat /data/workspaces/<anonymous-id>/quota.json
```

## Verified

Public smoke run 2026-10-13 from the deployed URL: 13 turns, 8 leads, $0.83 (eval/recordings/public-smoke-2026-10-13.txt)
