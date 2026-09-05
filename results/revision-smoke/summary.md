# WarehouseLab smoke validation

Code version: 40aaab7. Actual total runtime: 7.93 seconds. Actual simulations: 38.

Scope: benchmark-set. All methods use the same 3 explicit scene(s), evaluation seeds and fixed horizon (3 actual simulations per candidate). Human candidates are the first two configurations of each search and count in its budget.

Finite-batch/custom demand is stored in full with the result. Completed orders per horizon can saturate after all available orders finish; this is not evidence of a throughput ceiling under continuing demand.

| Method | Optimizer seed | Actual calls | Proposals | Cache hits | Best orders/tick | Mean unfinished | Mean waiting | Status |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| random | 7 | 18 | 6 | 0 | 0.037500 | 4.00 | 0.0446 | completed |
| ga | 7 | 18 | 6 | 0 | 0.037500 | 4.00 | 0.0480 | completed |

Human starting candidates (same conditions; these are included, not additional runs):

| Optimizer seed | Candidate | Mean orders/tick | Mean unfinished | Mean waiting |
| ---: | --- | ---: | ---: | ---: |
| 7 | BASELINE | 0.037500 | 4.00 | 0.0480 |
| 7 | QUEUE_AWARE | 0.031944 | 5.33 | 0.0014 |

Frozen selection on heldout map heldout-offset, seed 101: 6 completed orders, 3 unfinished, throughput 0.025000 orders/tick. Matched baseline: 6 orders. No reselection used this result; one comparison does not establish general improvement.

This small run is smoke validation only. It does not establish statistical significance, generalization or an optimizer advantage.

The JSON retains candidate records (including incomplete/error states), best-by-evaluation history, full scenario content, versions and all actual run details. CSV contains actual simulator invocations only.
