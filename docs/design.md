# Sorting simulation and search

## Runtime and measurements

The sorting workbench calls the pinned [TMO implementation](https://github.com/lunjohnzhang/tmo_public) and WPPL/PIBT planner from the [TMO paper](https://arxiv.org/abs/2510.03472) through a small native executable. The patch stores package destinations as integers, preserves parcel identity across rerouting and recirculation, and treats all assigned recirculation chutes as usable recirculation outlets. The original task-assignment, chute capacity/closing process and motion planner remain in use.

The objective is sorted parcels divided by executed ticks. Workstation pickups and recirculated parcels are not deliveries. The upstream task-completion rate is retained as a separate metric, so these results cannot be compared numerically with the paper's old throughput without reconciling definitions and simulator versions. Every comparison here uses the same corrected runtime.

Recorded robot positions and assignment/pickup/delivery/reroute/recirculation events come from execution. Parcel IDs survive rerouting. Navigation waiting counts actual wait actions away from the current goal, excluding service delays; it is not a causal congestion label. Auxiliary targets are 12-zone navigation-wait fractions and closed-chute fractions. Positions, goals, closure events and count curves support replay; no arbitrary-state simulator restore is assumed.

## Learned mapping search

Chutes are nodes with normalized geometry, workstation distances, assigned demand, destination counts, group spread and quotas. Two message-passing layers aggregate nearby chutes and chutes sharing a destination. Pooling supports different numbers of chutes and destinations. Destination names are never numeric features; renaming a destination together with its attributes preserves predictions.

Three bootstrap networks share a spatial representation between throughput regression and operational prediction. Normalized auxiliary mean squared error has weight 0.25; removing it is an explicit ablation. The simple baseline uses 48 bootstrapped extra trees over pooled analytic features. The flat auxiliary ablation uses a small pooled-feature network with the same supervision. Predictions retain the IDs of the completed observations that trained them.

All methods pay for the same four initial candidates: two independently constructed greedy mappings and two demand-weighted random mappings. No author-optimized mapping is imported. Evolutionary search uses geometric mutation from the incumbent and minimum-edit quota repair. Learned methods rank a pool containing geometric mutation, swap, transfer, spatial-block mutation and restarts. Transfers can change destination chute counts. The best upper-confidence score is selected first; subsequent choices combine normalized score and structural/spatial novelty within a high-score gate. A top-score-only ablation removes complementarity. Model disagreement is heuristic uncertainty, not a calibrated confidence interval.

A separate matched-budget reference executes the pinned upstream EA's proposal functions: a batch shares its mutation size, and the elite retains the unrepaired genotype. It uses the same four charged initial mappings and corrected simulator. Repair minimizes the same number of changed assignments, with deterministic tie selection rather than CPLEX's choice. Original upstream greedy generators are also evaluated separately. These adaptations and the demand profiles below prevent treating this as a reproduction of the paper's numerical results.

The design takes search guidance, shared auxiliary training and relevance-filtered complementarity principles from [Neural A*](https://proceedings.mlr.press/v139/yonetani21a.html), [DescRL](https://arxiv.org/abs/2510.21809), and [informative viewpoint selection](https://arxiv.org/abs/2609.33288). It does not reproduce those algorithms or use language supervision. Heatmap-assisted fitness models already appear in [warehouse layout optimization](https://arxiv.org/abs/1811.05685) and [DSAGE](https://arxiv.org/abs/2305.06436); [COMBO](https://arxiv.org/abs/1902.00448) and [LAW](https://arxiv.org/abs/2102.13382) are related combinatorial/batch optimization methods. Surrogates, auxiliary losses and diverse batches are established techniques; their measured utility for these mappings is the question here.

## Experiment protocol

The [frozen protocol](../results/tmo/protocol.json) separates two training conditions, a validation condition, and two unseen demand/fleet conditions on the 105-chute map. A 253-chute layout is a separate transfer test. The demand profiles use equal weights within hot, middle and cold tiers; they are project test conditions, not the upstream rank-weighted demand distribution. Different random seeds alone are not different scenarios. These are finite-horizon runs from the initial state, not steady-state throughput estimates. A 1500-tick validation pilot checks runtime cost, noise and the presence of operational events before choosing the comparison scale.

Each method has three independent optimizer runs, each with 24 actual calls: 12 mappings with two simulation repetitions. Final mappings are selected using only those observations, then measured on five distinct held-out seeds. All history-assisted methods receive the same 192 training-condition calls. History generation, online simulation, model training, independent final evaluation and pilot costs are reported separately. Models refit on historical plus current observations; this is historical-data assistance, not cost-free pretraining. Reported simulation and training times sum measured durations on this machine; concurrent execution and hardware affect them.

The simulator uses mapping-dependent random-number consumption. Identical seed labels provide comparison blocks, not matched external random streams. Descriptive intervals use a crossed bootstrap of optimizer runs and shared simulation-seed blocks; three optimizer runs do not support strong significance claims. Failed and cancelled attempts retain their actual costs; partial candidates cannot train the model or win. Cache hits are references to existing measurements, not extra simulations.

Reproduce on a fresh local data directory after building the runtime:

```sh
export WAREHOUSE_SORTING_DATA="$PWD/.sorting-data/reproduction"
python -m warehouse_sorting.experiments pilot
python -m warehouse_sorting.experiments freeze --cross-map
python -m warehouse_sorting.experiments run --workers 2
python -m warehouse_sorting.upstream_baseline freeze
python -m warehouse_sorting.upstream_baseline run
python -m warehouse_sorting.experiments summary
python -m warehouse_sorting.experiments export --destination results/tmo
```

The runner preserves a frozen protocol and completed studies. Repeating `run` reuses matching completed studies; it refuses changed simulator/source identities or incomplete studies rather than silently mixing evidence. [Measured results](../results/tmo/summary.json) include per-run values, cost ledgers, prediction errors and mechanism contrasts. The comparison evaluates this implementation and budget, not the original paper's numerical results.

## Results and limits

The full spatial/auxiliary/complementary method achieved these independent final means in sorted parcels per tick. Every cell averages three optimization runs and five final simulation seeds per run; each optimization had 24 online calls.

| Test condition | Cold start | With historical data |
| --- | ---: | ---: |
| 105 chutes, 600 robots, 70% hot demand | 6.2739 | 6.6886 |
| 105 chutes, 450 robots, 85% hot demand | 6.1605 | 6.5783 |
| Separate 253-chute layout, 600 robots | 8.1189 | 8.3830 |

The matched upstream EA averaged 6.0796 and 5.6272 in the two main conditions. The full cold-start method's paired differences were +0.1943 (descriptive 95% interval −0.1604 to +0.4855) and +0.5333 (+0.2307 to +0.8469). This is condition-dependent evidence, not a general superiority claim. The results also retain both independently constructed and original upstream greedy references.

The reported study used 2,687 successful native calls: 2,484 in the main protocol, nine in its pilot and 194 in the original-method reference. There were no failed, cancelled or cached calls. Accumulated simulation time was 4,828.72 seconds and training time 453.82 seconds. The [environment](../results/tmo/environment.json), compressed observations, frozen protocols and two representative model checkpoints are included; routine engineering tests are outside this experimental ledger.

Historical assistance improved this method's means, but required 192 additional training-condition simulations and more fitting time. It did not help every comparator: the simple surrogate's cross-map mean fell from 8.2005 to 8.1183. The study does not establish that historical learning pays for itself under a single-task total-cost budget.

The spatial representation did not consistently outperform pooled features. Auxiliary supervision changed the first learned batch in all six cold-start comparisons, but its final throughput difference from score-only training was negative in both cold-start conditions and mixed with history. Better auxiliary prediction was therefore insufficient evidence of better optimization. On the selected cold-start candidates, throughput ranking remained weak; four initialization observations and eight further candidates leave little data for shared representation learning.

Complementarity changed few selections: all six cold-start runs evaluated the same guided candidate sets as top-score selection, with only ordering differences, and all six final winning mappings were identical. With history, its throughput differences were −0.1520 and +0.1176 in the two main conditions. The quality gate, modest novelty weight and mostly local proposals limit its influence. These are diagnostics of this setting, not causal explanations or a tuned claim of improvement. No parameters were changed in response to final-test outcomes. Per-run values, descriptive intervals and prediction errors remain available in the results.

---

# Factory simulation

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
