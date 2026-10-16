# Eval Report

## Scenario x Arm

| Scenario | Arm | n | pass@1 | pass^3 | mean good | mean precision | mean cost/good | p50 ms | p95 ms | workflow-shaped |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| S1 | C_agent_sonnet | 1 | 1.00 | n/a (n=1) | 7.00 | 0.88 | 0.1258 | 212883 | 212883 | 0.00 |
| S1 | D_agent_kimi | 1 | 0.00 | n/a (n=1) | 3.00 | 0.75 | 0.1865 | 374886 | 374886 | 0.00 |
| S2 | C_agent_sonnet | 1 | 1.00 | n/a (n=1) | 9.00 | 0.90 | 0.0676 | 157569 | 157569 | 0.00 |
| S2 | D_agent_kimi | 1 | 0.00 | n/a (n=1) | 5.00 | 0.83 | 0.1220 | 386361 | 386361 | 0.00 |

## Cells

| Scenario | Arm | Rep | good | precision | spend/good | latency ms | stop | adaptive | workflow-shaped | pass |
|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|
| S1 | C_agent_sonnet | 1 | 7 | 0.88 | 0.1258 | 212883 | budget | 43 | no | yes |
| S1 | D_agent_kimi | 1 | 3 | 0.75 | 0.1865 | 374886 | max_active_ms | 11 | no | no |
| S2 | C_agent_sonnet | 1 | 9 | 0.90 | 0.0676 | 157569 | target_leads | 4 | no | yes |
| S2 | D_agent_kimi | 1 | 5 | 0.83 | 0.1220 | 386361 | max_active_ms | 4 | no | no |
