# Eval Report

## Scenario x Arm

| Scenario | Arm | n | pass@1 | pass^3 | mean good | mean precision | mean cost/good | p50 ms | p95 ms | workflow-shaped |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| S1 | A_workflow | 3 | 0.00 | 0 | 2.00 | 0.35 | 0.3805 | 55153 | 57469 | 0.00 |
| S1 | B_agent_opus | 3 | 1.00 | 1 | 7.33 | 0.88 | 0.1179 | 132147 | 135423 | 0.00 |
| S2 | A_workflow | 3 | 0.00 | 0 | 0.33 | 0.08 | Infinity | 68754 | 91011 | 0.00 |
| S2 | B_agent_opus | 3 | 1.00 | 1 | 8.00 | 0.80 | 0.0896 | 102122 | 153419 | 0.00 |

## Cells

| Scenario | Arm | Rep | good | precision | spend/good | latency ms | stop | adaptive | workflow-shaped | pass |
|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|
| S1 | A_workflow | 1 | 2 | 0.50 | 0.3730 | 55153 | finish | 0 | no | no |
| S1 | A_workflow | 2 | 2 | 0.22 | 0.3865 | 51802 | finish | 0 | no | no |
| S1 | A_workflow | 3 | 2 | 0.33 | 0.3820 | 57469 | finish | 0 | no | no |
| S1 | B_agent_opus | 1 | 9 | 0.90 | 0.0903 | 135423 | target_leads | 39 | no | yes |
| S1 | B_agent_opus | 2 | 7 | 0.88 | 0.1219 | 120163 | budget | 49 | no | yes |
| S1 | B_agent_opus | 3 | 6 | 0.86 | 0.1416 | 132147 | finish | 53 | no | yes |
| S2 | A_workflow | 1 | 0 | 0.00 | Infinity | 91011 | budget | 0 | no | no |
| S2 | A_workflow | 2 | 1 | 0.25 | 0.8980 | 68754 | budget | 0 | no | no |
| S2 | A_workflow | 3 | 0 | 0.00 | Infinity | 60342 | budget | 0 | no | no |
| S2 | B_agent_opus | 1 | 8 | 0.80 | 0.1060 | 153419 | target_leads | 12 | no | yes |
| S2 | B_agent_opus | 2 | 8 | 0.80 | 0.0650 | 73027 | target_leads | 17 | no | yes |
| S2 | B_agent_opus | 3 | 8 | 0.80 | 0.0977 | 102122 | target_leads | 23 | no | yes |
