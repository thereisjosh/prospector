# Eval Report

## Scenario x Arm

| Scenario | Arm | n | pass@1 | pass^3 | mean good | mean precision | mean cost/good | p50 ms | p95 ms | workflow-shaped |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| S1 | B_agent_opus | 2 | 0.00 | n/a (n=2) | 4.50 | 0.92 | 0.1943 | 275128 | 319047 | 0.00 |
| S2 | B_agent_opus | 2 | 0.00 | n/a (n=2) | 1.50 | 0.50 | Infinity | 176536 | 281150 | 0.00 |

## Cells

| Scenario | Arm | Rep | good | precision | spend/good | latency ms | stop | adaptive | workflow-shaped | pass |
|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|
| S1 | B_agent_opus | 1 | 4 | 1.00 | 0.2180 | 275128 | finish | 71 | no | no |
| S1 | B_agent_opus | 2 | 5 | 0.83 | 0.1705 | 319047 | finish | 56 | no | no |
| S2 | B_agent_opus | 1 | 0 | 0.00 | Infinity | 176536 | finish | 16 | no | no |
| S2 | B_agent_opus | 2 | 3 | 1.00 | 0.2732 | 281150 | finish | 27 | no | no |
