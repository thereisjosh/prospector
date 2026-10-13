# Eval Report

## Scenario x Arm

| Scenario | Arm | n | pass@1 | pass^3 | mean good | mean precision | mean cost/good | p50 ms | p95 ms | workflow-shaped |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| S1 | A_workflow | 3 | 0.00 | 0 | 1.00 | 0.18 | 0.7610 | 55153 | 57469 | 0.00 |
| S1 | B_agent_opus | 3 | 0.00 | 0 | 4.33 | 0.52 | 0.1961 | 132147 | 135423 | 0.00 |
| S2 | A_workflow | 3 | 0.00 | 0 | 0.00 | 0.00 | Infinity | 68754 | 91011 | 0.00 |
| S2 | B_agent_opus | 3 | 0.00 | 0 | 3.33 | 0.33 | 0.2172 | 102122 | 153419 | 0.00 |

## Cells

| Scenario | Arm | Rep | good | precision | spend/good | latency ms | stop | adaptive | workflow-shaped | pass |
|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|
| S1 | A_workflow | 1 | 1 | 0.25 | 0.7460 | 55153 | finish | 0 | no | no |
| S1 | A_workflow | 2 | 1 | 0.11 | 0.7730 | 51802 | finish | 0 | no | no |
| S1 | A_workflow | 3 | 1 | 0.17 | 0.7640 | 57469 | finish | 0 | no | no |
| S1 | B_agent_opus | 1 | 5 | 0.50 | 0.1625 | 135423 | target_leads | 39 | no | no |
| S1 | B_agent_opus | 2 | 4 | 0.50 | 0.2133 | 120163 | budget | 49 | no | no |
| S1 | B_agent_opus | 3 | 4 | 0.57 | 0.2124 | 132147 | finish | 53 | no | no |
| S2 | A_workflow | 1 | 0 | 0.00 | Infinity | 91011 | budget | 0 | no | no |
| S2 | A_workflow | 2 | 0 | 0.00 | Infinity | 68754 | budget | 0 | no | no |
| S2 | A_workflow | 3 | 0 | 0.00 | Infinity | 60342 | budget | 0 | no | no |
| S2 | B_agent_opus | 1 | 3 | 0.30 | 0.2827 | 153419 | target_leads | 12 | no | no |
| S2 | B_agent_opus | 2 | 3 | 0.30 | 0.1733 | 73027 | target_leads | 17 | no | no |
| S2 | B_agent_opus | 3 | 4 | 0.40 | 0.1955 | 102122 | target_leads | 23 | no | no |
