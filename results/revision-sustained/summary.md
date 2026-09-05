# WarehouseLab smoke validation

Code version: 40aaab7. Actual total runtime: 35.05 seconds. Actual simulations: 8.

Scope: benchmark-set. All methods use the same 1 explicit scene(s), evaluation seeds and fixed horizon (1 actual simulations per candidate). Human candidates are the first two configurations of each search and count in its budget.

Sustained demand uses the fixed 2,000-order stream in sustained-production. There is no warm-up exclusion: every completion through the horizon counts. Arrived unfinished orders and their oldest age expose backlog.

| Method | Optimizer seed | Actual calls | Proposals | Cache hits | Best orders/tick | Mean unfinished | Mean waiting | Status |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| random | 7 | 4 | 4 | 0 | 0.111667 | 54.00 | 0.0015 | completed |
| ga | 7 | 4 | 4 | 0 | 0.111667 | 54.00 | 0.0015 | completed |

Human starting candidates (same conditions; these are included, not additional runs):

| Optimizer seed | Candidate | Mean orders/tick | Mean unfinished | Mean waiting |
| ---: | --- | ---: | ---: | ---: |
| 7 | BASELINE | 0.078333 | 74.00 | 0.2218 |
| 7 | QUEUE_AWARE | 0.111667 | 54.00 | 0.0015 |

This scope has no heldout evaluation.

This small run is smoke validation only. It does not establish statistical significance, generalization or an optimizer advantage.

The JSON retains candidate records (including incomplete/error states), best-by-evaluation history, full scenario content, versions and all actual run details. CSV contains actual simulator invocations only.
