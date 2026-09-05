# WarehouseLab smoke validation

Code version: 8b7262b. Actual total runtime: 6.83 seconds. Actual simulations: 37.

All methods use the same three training maps, evaluation seeds and fixed horizon. Human candidates are the first two evaluated configurations of each search and are included in its simulation budget.

| Method | Optimizer seed | Actual calls | Proposals | Cache hits | Best orders/tick | Mean unfinished | Mean waiting | Status |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| random | 7 | 18 | 6 | 0 | 0.037500 | 4.00 | 0.0376 | completed |
| ga | 7 | 18 | 6 | 0 | 0.037500 | 4.00 | 0.0456 | completed |

Human starting candidates (same conditions; these are included, not additional runs):

| Optimizer seed | Candidate | Mean orders/tick | Mean unfinished | Mean waiting |
| ---: | --- | ---: | ---: | ---: |
| 7 | BASELINE | 0.037500 | 4.00 | 0.0456 |
| 7 | QUEUE_AWARE | 0.033333 | 5.00 | 0.0010 |

Frozen selection on heldout map heldout-offset, seed 101: 6 completed orders, 3 unfinished, throughput 0.025000 orders/tick. No reselection used this result.

This small run is smoke validation only. It does not establish statistical significance, generalization or an optimizer advantage.

The JSON retains candidate records (including incomplete/error states), best-by-evaluation history, full scenario content, versions and all actual run details. CSV contains actual simulator invocations only.
