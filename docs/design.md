# Simulation and search

Browser workers and the Node CLI use the same TypeScript kernel in [`src/core`](../src/core). Scenarios, policies and seeded orders determine integer-tick decisions. Wall-clock timings are diagnostics and do not affect simulation outcomes.

## Production and motion

Each tick finishes loading/unloading, updates suppliers and processing, assigns transports, plans robot moves, commits positions simultaneously, and updates metrics. Executable deliveries are considered by order arrival and ID before assembly and processing inputs. A robot carries one item batch; earliest-finish dispatch can also queue two future tasks.

Assignment reserves source stock and destination capacity. Material moves between buffers, processing and robot loads when the corresponding service completes. Each tick checks collisions, capacities and conservation:

```text
input buffers + output buffers + robot loads + processing inputs
    = externally supplied + produced - consumed - delivered
```

Static A* and prioritized space-time A* use obstacle-aware distance fields. Robots reserve cells and edges through a bounded planning window; waiting robots retain their occupancy. A simultaneous-motion check prevents conflicting destinations and edge swaps. Routes are reused only while their goal, geometry, policy and reservations remain valid. Conservative reservations can leave opposing traffic congested or stuck.

Replay restores a checkpoint and executes the same kernel. The display interpolates adjacent executed ticks; planned routes are separate overlays. Editing restores the initial layout and clears the replay range.

## Policy search

Each candidate runs on the same frozen scenarios, seeds and horizon. Ranking uses mean `completedOrders / horizon`, then fewer unfinished orders, lower traffic waiting and deterministic configuration order. Only complete evaluation sets can become the best candidate. Every started simulation counts toward the budget, including failed or cancelled calls; cached runs do not add calls.

Both methods start with the same two counted presets. Random search samples legal configurations. The mixed-variable GA uses tournament selection, categorical/integer inheritance, arithmetic crossover for congestion weight, bounded mutation and one elite per complete generation. Small budgets can finish before offspring are evaluated.

Search exports retain the full scene, policy, run conditions and candidate history. Fixed-set benchmarks select on the three training maps before evaluating the frozen choice and a matched baseline on the held-out map. See the [usage guide](usage.md) for budgets and commands.

## Recorded experiments

These files retain their original numbers, conditions and source versions:

- [Kernel 1.0.0 smoke run](../results/smoke/summary.md): 37 calls; historical kernel semantics.
- [Kernel 1.1.0 quick run](../results/revision-smoke/summary.md): 38 calls; both searches matched baseline throughput. The [source manifest](../results/revision-smoke/source-manifest.json) identifies the evaluated files.
- [Kernel 1.1.0 sustained run](../results/revision-sustained/summary.md): eight calls; both searches selected the supplied queue-aware preset.
- [Browser performance measurements](performance.md), with raw samples and reproduction commands.

The small search runs did not find a policy better than both presets. The fixed examples have finite demand; the sustained scene keeps receiving seeded orders throughout its measured horizon.

Related reading: [Guidance Graph Optimization](https://arxiv.org/abs/2402.01446), [Online Guidance Graph Optimization](https://arxiv.org/abs/2411.16506), and [Factorio: Smarter robots](https://factorio.com/blog/post/fff-374). WarehouseLab uses its own ground-robot simulation and a small set of dispatch/routing parameters.
