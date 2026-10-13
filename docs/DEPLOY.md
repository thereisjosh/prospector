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
| `DAILY_SPEND_CAP_DOLLARS` | `10` | Global daily live spend cap. |
| `VISITOR_MAX_LIVE_RUNS` | `2` (production: `3`) | Per anonymous workspace live-run allowance. Production decision: 3 runs or $2.50, whichever comes first. |
| `VISITOR_MAX_DOLLARS` | `2.50` | Per anonymous workspace live/planner spend allowance. |
| `DEMO_MODE` | unset | Set `1` to force recorded demo mode. |
| `LIVE_MODE` | unset | Set `off` to pause live mode. |

Kill switch: set `DAILY_SPEND_CAP_DOLLARS=0` or `LIVE_MODE=off`. The API behaves as demo-only, and `/api/status` reports `{ "mode": "demo", "reason": "paused" }`.

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
