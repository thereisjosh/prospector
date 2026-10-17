# Eval Report

## Scenario x Arm

| Scenario | Arm | n | pass@1 | pass^3 | mean good | mean precision | mean cost/good | p50 ms | p95 ms | workflow-shaped |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| S1 | C_agent_sonnet | 2 | 0.50 | n/a (n=2) | 6.50 | 0.86 | 0.1426 | 129540 | 131967 | 0.00 |
| S2 | C_agent_sonnet | 2 | 1.00 | n/a (n=2) | 9.00 | 0.90 | 0.0541 | 91613 | 92815 | 0.00 |

## Cells

| Scenario | Arm | Rep | good | precision | spend/good | latency ms | stop | adaptive | workflow-shaped | pass |
|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|
| S1 | C_agent_sonnet | 2 | 8 | 0.89 | 0.1094 | 131967 | budget | 54 | no | yes |
| S1 | C_agent_sonnet | 3 | 5 | 0.83 | 0.1757 | 129540 | budget | 18 | no | no |
| S2 | C_agent_sonnet | 2 | 9 | 0.90 | 0.0480 | 92815 | target_leads | 2 | no | yes |
| S2 | C_agent_sonnet | 3 | 9 | 0.90 | 0.0602 | 91613 | target_leads | 4 | no | yes |
