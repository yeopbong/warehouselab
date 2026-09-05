# Validation and experiments

Kernel `1.1.0` changes planning and dispatch semantics relative to `1.0.0`. Compare runs only under matching kernel versions, scenarios, policies, seeds and horizons. Historical files in `results/smoke/` describe kernel `1.0.0`; the `results/revision-smoke/` and `results/revision-sustained/` directories describe kernel `1.1.0`.

## Automated checks

The suite covers short-window detours, unreachable goals, global order age, static task connectivity, material and collision invariants, current-factory evaluation, partial-call budgets, stale messages, bounded checkpoints and executed-frame interpolation. Production browser tests cover zoom/pan/drag Undo, gesture cancellation, draft inputs, exact playback/replay digests, search/comparison cancellation, result provenance, reordered imports and File-menu behavior. Layout checks use 1440×900, 1280×800 and 390px-wide viewports. The main workflow asserts no page or console errors.

Recorded kernel `1.1.0` checks used macOS arm64, Apple M2 / 16 GB, Node.js 24.19.0, npm 12.0.2 and Google Chrome 152.0.7977.76:

| Check | Recorded outcome |
| --- | --- |
| Strict TypeScript check and production build | Passed |
| Unit and integration tests | 108 tests in 11 files passed, 30.66 seconds |
| Production Chrome workflows | 18 passed, 34.3 seconds |
| Linux CI | Both jobs passed on Ubuntu / Node 22; 108 tests in 11 files and 18 production Chromium workflows. Core tests took 37.71 seconds on original revision `7208ac44ecac1d6771993de9df77b0856dd8538f`; the published source equivalent is `9b45d3d6f6447af8c8e23e2a4c99a5ea304fefe4`. |

The 600-tick, 12-robot sustained invariant regression has a 20-second test deadline to accommodate slower runners. It executes the complete horizon and collision/material assertions; this test deadline is separate from measured browser latency.

See [usage](usage.md#validation-and-command-line-runs) for commands and [performance](performance.md) for production browser measurements. rAF/Canvas draw cadence does not measure physical screen presentation.

## Kernel 1.1.0 experiments

Both small experiments used source `40aaab72a750d9bc8f3ec63175b2718809b14553`. The [source SHA256 manifest](../results/revision-smoke/source-manifest.json) records the evaluated files. The corresponding implementation was recorded as `9b45d3d6f6447af8c8e23e2a4c99a5ea304fefe4` (original revision `7208ac44ecac1d6771993de9df77b0856dd8538f`). Its only difference within the source manifest is a four-line mobile File-menu CSS alignment change; the kernel, workers and benchmark code are identical to the measured source.

| Run | Calls / elapsed | Outcome |
| --- | --- | --- |
| [Fixed-set quick](../results/revision-smoke/summary.md) | 38 / 7.93s | Baseline, random best and GA best all 0.0375 orders/tick. Frozen selection and matched baseline both complete 6 held-out orders at seed 101 / 240 ticks. |
| [Sustained demand](../results/revision-sustained/summary.md) | 8 / 35.05s | 600 ticks, seed 11, budget 4 per method. Baseline completes 47 (0.078333/tick), queue-aware 67 (0.111667/tick); both optimizers select the supplied queue-aware starting candidate. |

Neither experiment found a policy better than both supplied human starting candidates. These small runs do not establish statistical or generalization advantages; no full multi-seed experiment was run for kernel `1.1.0`. Existing finite scenarios use the same order batches as kernel `1.0.0`. The sustained scene receives predetermined seeded demand throughout the measured horizon, with no warm-up exclusion. Every started simulation counts, including both starting candidates.

## Historical kernel 1.0.0 results

The 2026-09-05 measurements used source `8b7262bbbd33aef531185195ce4eda54f622ac15`, Node.js 24.19.0, npm 12.0.2, macOS arm64 and Google Chrome 152.0.7977.76. The corresponding implementation was recorded as `3c12b81b2133a1675f36b2bae320da0cfaf8b3b3` (original revision `bb5be4045c5d28b61b61c29fde6bb7e6c04db3b0`). These are historical measurements, not results for kernel `1.1.0`.

| Check | Recorded outcome |
| --- | --- |
| `npm run validate` | Strict type check, 62 tests in 5 files, production build and quick benchmark passed |
| Production Chrome workflows | 3 passed, 8.5 seconds |
| Browser/Node equality | Exact state digest at tick 240 for Open floor, baseline, seed 41 |
| Browser errors | No page or console errors in the main workflow |
| Production playback | First completed order at tick 64 |
| Exported scenario + policy CLI | Open floor JSON + queue-aware JSON, seed 11, 240 ticks: 9 completed orders, 0 unfinished |
| Default full chain | Open floor baseline, seed 41, 600 ticks: 20 completed orders, 0 unfinished, no invariant failure |
| Linux CI | Core and browser jobs passed with Node 22. Recorded CI run: `33954530212`. |

The quick benchmark used 37 actual simulations in 6.83 seconds. Each optimizer spent 18 calls on the same three maps and evaluation seed, including the same two human starting candidates. The last call evaluated the frozen selection on the held-out map. Kernel `1.1.0` quick mode uses 38 calls because it also evaluates a matched held-out baseline.

| Policy / method | Training mean orders/tick | Mean unfinished | Mean traffic waiting |
| --- | ---: | ---: | ---: |
| Baseline | 0.037500 | 4.00 | 0.0456 |
| Queue aware | 0.033333 | 5.00 | 0.0010 |
| Random search best | 0.037500 | 4.00 | 0.0376 |
| Genetic algorithm best | 0.037500 | 4.00 | 0.0456 |

The primary throughput score did not improve over baseline. Random search improved only the waiting tie-breaker. The frozen selected configuration completed 6 orders with 3 unfinished on the held-out offset map at seed 101 and horizon 240. This is a smoke experiment, not a statistical or generalization claim.

The [JSON records](../results/smoke/benchmark.json), [CSV](../results/smoke/runs.csv) and [generated summary](../results/smoke/summary.md) retain exact conditions, candidate history, runtimes, versions and hashes. The larger multi-optimizer-seed benchmark is available as `npm run benchmark -- --full`, but was not part of these historical measurements.
