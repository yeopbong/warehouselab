# Browser performance

Measured 2026-09-05 on the same Apple M2 / 16 GB macOS arm64 machine, Chrome 152.0.7977.76 in headless mode, 1440×900 viewport, DPR 1, reduced motion off. Both builds used the baseline policy, the same scenes/seeds, All paths on and heatmap off. Before source: `063f22c`, production preview 4175. After source: `40aaab7`, production preview 4176. The measured source predates a mobile File-menu alignment change limited to a max-width:759px CSS rule; that rule does not apply at the measured viewport.

Each normal sample lasts 30 seconds; the separate 64× sample lasts 10 seconds. New 1× intentionally means 6 ticks/s; old 1× had a nominal 12.5 ticks/s ceiling before computation. Actual rates below therefore describe different pacing contracts, not a faster-kernel claim. No logical ticks, orders, seeds or search budgets were dropped to improve the figures. The lower message volume reflects both smaller packets and the new lower normal tick rate.

## Measured results

| Measure | Before | After |
| --- | ---: | ---: |
| Default Canvas paint interval, median / P95 | 83.3 / 100.0 ms | 16.7 / 16.7 ms |
| 12-robot sustained Canvas interval, median / P95 | 100.0 / 116.7 ms | 16.7 / 16.7 ms |
| rAF interval, median / P95, both normal samples | 16.7 / 16.7 ms | 16.7 / 16.7 ms |
| Main-thread tasks >50ms, both normal samples | 0 / 0 | 0 / 0 |
| Actual ticks/s, default / sustained | 11.53 / 9.50 | 5.97 / 5.97 |
| Canvas width/height assignments, default / sustained | 692 / 570 | 0 / 0 |
| Estimated worker JSON volume, default / sustained | 6.38 / 87.50 MB | 0.56 / 1.76 MB |
| Main-thread task time over 30s, default / sustained | 1.81 / 1.18 s | 2.43 / 1.96 s |
| Canvas API time over 30s, default / sustained | 80.5 / 71.0 ms | 234.9 / 225.5 ms |
| Pause acknowledgment, default / sustained | 15.8 / 14.6 ms | 14.5 / 15.1 ms |
| Search cancel acknowledgment | 696.5 ms | 14.7 ms |
| Comparison cancel acknowledgment | 261.2 ms | 15.5 ms |
| Seek acknowledgments: ticks 1800 / 2200 / 1600 | 373.0 / 422.2 / 353.1 ms | 14.5 / 14.7 / 14.6 ms |
| Selection/panel visible feedback during search | 9.9–15.8 ms | 10.5–15.1 ms |
| Zoom feedback during search | unavailable in old UI | 11.6 ms |
| Separate 64× actual ticks/s | 684.53 | 379.67 (target 384) |
| Separate 64× Canvas interval median / P95 | 99.9 / 100.1 ms | 16.7 / 16.8 ms |
| Page scroll height at 900px viewport | 1080 px | 900 px |

Normal playback produced 1,799 Canvas paint intervals per 30-second sample after the revision, versus 346/285 before. More frequent drawing costs more main-thread time; the measurements do **not** show that React was causing long stalls. They identify snapshot-limited movement, repeated bitmap resets, large state payloads, synchronous cancellation and from-zero replay as concrete problems. All normal/high-speed samples had zero >50ms main-thread tasks, and the completed harness reported zero console errors/failures.

Search interaction sampling also found zero long tasks. The supplemental before run sampled 4 progress messages plus one result (estimated 3.64 KB); after sampled 8 progress messages plus one result (9.85 KB). The revised partial-run progress is more frequent and carries explicit scope/current-tick accounting: these short cancelled samples do not demonstrate a payload reduction. Completed history is now sent at completion rather than copied into every progress message; worker-message schemas and tests verify that bound. The fuller sample duration differs because cancellation now completes sooner.

## Method and limits

[Before raw data](../results/performance/before.json), [supplemental before interactions](../results/performance/before-interactions.json), and [after raw data](../results/performance/after.json) retain all sampled intervals, CDP Performance task/script/layout totals, PerformanceObserver long tasks, input/worker acknowledgment timestamps and message counts. After data records SHA256/bytes for the actual served JS, CSS and worker bundles. A selected-source fingerprint is a directory snapshot, not a substitute for that build identity. Source versions and experiment conditions are documented in [validation](validation.md).

**rAF and Canvas invocation cadence are not physical screen-presented FPS.** Headless Chrome does not measure compositor presentation or a monitor. Canvas API timing covers instrumented drawing calls, not total GPU/render cost. JSON volume is a sampled serialization estimate, not structured-clone transport bytes; instrumentation itself adds overhead. Ordinary feedback is checked at a following rAF, while cancellation uses the actual terminal worker response. These are individual reproducible samples, not statistical latency guarantees. All raw slow intervals remain. Files named `pre-final` contain incomplete interaction measurements and are excluded from the table above.

The runtime targets bounded 6ms/12-tick work chunks, publishes visual frames independently of 200ms property snapshots, and keeps at most 96 executed display frames and 24 replay checkpoints. At >8×, real states are sampled, with no invented interpolation across skipped segments. Checkpoints help nearby retained targets; evicted targets may require replay from tick 0. A single expensive tick remains atomic, so difficult maps can still exceed latency goals. Reduced motion/background resume disable unnecessary interpolation and bound catch-up debt.

Reproduce with production previews and no concurrent benchmarks. The before comparison requires a separate copy of baseline source `063f22c`; this checkout contains the after implementation:

```sh
npm run build
npm run preview -- --port 4176 --strictPort
# In another terminal, from this checkout:
npm run measure:browser -- --mode after --url http://127.0.0.1:4176 --seconds 30 --high-seconds 10 --all-paths true --out results/runs/performance-after.json
# Same harness against a separate production build of baseline source 063f22c:
npm run measure:browser -- --mode before --url http://127.0.0.1:4175 --source-dir /path/to/baseline --out results/runs/performance-before.json
```

The harness uses installed Chrome. Browser layout tests cover desktop run/edit/search states at 1440×900 and 1280×800 and the 390px narrow layout, including main controls without page scrolling. Before/after snapshots: [before 1440](before-1440.png), [after 1440](after-1440.png), [before 1280](before-1280.png), [after 1280](after-1280.png).

Implementation references: [MDN rAF timestamps](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame), [MDN Canvas caching](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas), and [React Profiler](https://react.dev/reference/react/Profiler). Profiling instrumentation is optional and adds overhead; the main comparison uses the ordinary production build.
