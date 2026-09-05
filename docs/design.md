# Kernel and search design

The executable model is `src/core/sim/engine.ts`. Browser workers and Node scripts call this kernel; rendering never executes a separate set of physical rules.

## State and tick order

`createSimulation` validates and clones the scenario, normalizes the policy, initializes empty inventories, and materializes the entire seeded order stream before execution. Fixed and generated orders are sorted by arrival and stable ID. The optimizer RNG is separate. Only arrived orders influence task assignment, replenishment, and pending-demand checks; routing sees current robot positions.

Each `step` performs the following commits:

1. Increment the integer tick and finish loading/unloading services whose completion tick has arrived.
2. Replenish suppliers when arrived demand exists, their interval is due, and output space is available. Decrement active processing; commit completed recipes when output space permits; start eligible new recipes.
3. Assign executable delivery transports by global order arrival time, then order ID, across all delivery stations. Skip currently unavailable deliveries; follow with assembly and processing inputs in stable station order. Choose an available source and robot, then commit reservations immediately before considering another task.
4. Derive robot goals from the first committed task. A robot already at its target begins a one-tick loading/unloading service and remains physically present. An idle robot returns to its distinct initial parking cell when away from it.
5. Plan all next positions from one position snapshot. Validate simultaneous actions, then commit all positions together. A robot moves at most one cardinal cell or waits.
6. Update traffic waits, the wait heatmap, and the stall diagnostic; check collision, task, stock, capacity, order, and conservation invariants.

Newly started processing is not decremented in the same tick. A finished batch can start another batch in its completion tick if inputs exist. Stable policy priority intentionally influences reservations; iterating and moving robots one by one never determines physical occupancy.

## Tasks, buffers, and material accounting

Each transport task is a batch of one item unit. A robot carries at most one batch. Nearest dispatch admits only a robot with no task; earliest-finish dispatch permits one active task plus two future commitments. Its approximate ETA adds current work, remaining service, Manhattan travel through committed pickups/dropoffs, their service costs, and travel from the resulting endpoint to the proposed task. It is not a traffic-aware schedule.

At assignment, source `reservedOutput` increases, destination `reservedInput` increases, and an order's reserved quantity increases if this is a final delivery. Reservations are claims, not extra physical stock. Later assignments use only unreserved output and destination capacity after accounting for inbound commitments. Recipe input assignments respect the relative quantities needed for whole recipe batches.

At loading completion, stock moves from source output to robot load and the source reservation is released. At unloading completion, load moves to destination input, or to the delivered ledger and order counters, and inbound/order reservations are released. Only an order with zero remaining quantity receives a completion tick. A reserved task can be cancelled through `cancelTask`, which releases every associated reservation and clears its active path/service when necessary. A task already carrying material cannot be silently cancelled or discarded.

Starting a recipe transfers inputs from the input buffer into `processing.inputs`. Those inputs remain physical material while processing, including while a finished batch waits for output capacity. At successful completion, input quantities are recorded as consumed and the recipe output is recorded as produced and inserted into output stock. Thus processing never creates inventory before its output commit. Suppliers record each external unit in `ledger.supplied`; final delivery records each received unit in `ledger.delivered`.

For every item, after each tick:

```text
input buffers + output buffers + robot loads + processing inputs
    = externally supplied + produced - consumed - delivered
```

Input stock plus inbound reservations cannot exceed input capacity. Output stock cannot exceed output capacity, and output reservations cannot exceed stock. Quantities remain nonnegative integers. Processing storage is separate from the input buffer; completed but blocked batches occupy the processing slot.

## Motion and rolling planning

Station bodies and obstacles are blocked; service cells are walkable. Static A* and space-time A* use obstacle-aware reverse-BFS distance lower bounds and stable tie breaking. The derived distance cache is bounded by 64 fields and 102,400 cells; exact topology/goal keys prevent reuse after geometry changes. Space-time search includes wait actions. Route cost is `1 + weight × observed density`: density is 1 at each current robot position and 0.5 at its cardinal neighbors. It has no access to future orders and never relaxes collision constraints.

A fresh owner-scoped reservation table is built each tick. Initially every robot holds its actual position for the whole planning window. In explicit priority order, release only that robot's reservations, then atomically reserve its path; unplanned, idle, serving, or unsuccessful robots keep occupying real cells. Reserve path endpoints through the remaining horizon. Vertex reservations prevent shared cells; reverse-edge checks prevent swaps.

Cached paths are reused only before the replan interval expires and only if goal, configuration, geometry, and reservations still validate. Otherwise a new search runs immediately. Tables use time relative to the current snapshot, so old reservations cannot leak into a later tick. A failed replacement does not overwrite another robot's claims.

A reached goal is accepted only if it can be held until the horizon. Otherwise choose a safe endpoint at exactly the planning horizon by lowest static obstacle-aware distance, then accumulated route cost, then stable search order. The single-robot wall detour regression reaches its goal in 20 steps with windows 4, 12 and 16, including the necessary temporary increase in Manhattan distance. Static guidance is never permission to cross traffic reservations. Conservative holds can still reduce throughput or leave opposing traffic stuck; no arbitrary-map completeness or deadlock-freedom guarantee is made.

The simultaneous-action backstop stops invalid/conflicting movers and propagates those holds to robots that would enter their now-stationary positions. Same-cell collisions, edge swaps, wall entry, and entry into a robot that does not actually leave are prohibited. Following a robot that really leaves is allowed. These are hard rules, not objective penalties. More implementation detail is in [planning-notes.md](planning-notes.md).

## Replay, diagnostics, and search records

Replay restores the nearest checkpoint at or before a previously reached target and executes the same `step` function. At most 24 checkpoints, including tick 0, are kept at 120-tick intervals. Serializable planner reuse metadata is part of SimState, so a cloned or JSON-restored checkpoint reproduces the original decisions. Older evicted targets can still replay from tick 0. Work yields at safe tick boundaries; newer request IDs invalidate older seeks. UI timeline requests are coalesced over 100ms. Scene/policy edits clear checkpoints and display frames. The simulation keeps the original 400-event recent log; replay never depends on the full log.

Delay is completion tick minus order arrival, reported only for completed orders. Unfinished counts only orders that have arrived. Oldest unfinished age is current tick minus the oldest arrived unfinished order arrival, or null when none remain. Waiting ratio counts ticks where a robot with a movement goal cannot move; normal service and idle time are separate states. Processing utilization counts active processing ticks, excluding output-blocked ticks. When arrived unfinished demand remains, no station is actively processing, and no progress event has occurred for more than 80 ticks, a warning and stalled-tick counter are recorded. This is a diagnostic heuristic: progress elsewhere can mask one blocked robot. No order, robot, or stalled run is erased, and fixed-horizon runs never exit early for stalling.

Optimization evaluates each candidate on an unchanged Cartesian set of maps and order seeds. The score is mean `completedOrders / horizon`; ties prefer fewer unfinished orders, then lower waiting ratio, then canonical configuration order. Delays and stalls remain diagnostics. Only complete evaluation sets can become the best candidate. Collision/conservation failures stop the search and preserve failure records.

Random and GA searches use the same two counted human starting candidates and fresh independent caches. The GA initializes legal mixed configurations, uses two-way tournament selection, uniform categorical/integer inheritance, arithmetic continuous crossover, bounded mutation, and one elite per complete generation. Distance routing normalizes its inactive weight to zero. Both actual-call and proposal limits terminate the search; incomplete budgets, cancellation, failed evaluations, and proposal limits have explicit statuses. Cancellation yields within simulator calls, after at most 32 ticks or approximately 8ms (a single tick is indivisible), preserving completed and cancelled partial runs. Every started call consumes budget. Only completed map/seed sets can be ranked. Request/revision identities isolate active messages; superseded jobs emit separate retired accounting records, retained in a bounded three-run UI archive. History records best completed results against actual simulation count.

Each search freezes validated full scenarios, seeds, horizon, parameter ranges, code/kernel versions, scope and per-candidate call cost. Its private FIFO cache holds at most 2,048 runs, keyed by exact frozen scene index, normalized policy and seed. Other evaluation conditions are immutable for that cache lifetime; no hash-only lookup can confuse maps. The standalone cacheKey helper contains full canonical scene content and all conditions. Exported scene/state hashes are compact FNV-1a identifiers, not cryptographic guarantees. Runtime and planning duration are measured using wall time solely as diagnostics; neither affects decisions or seeded randomness, and planning duration is excluded from the state digest.

CLI versions are the current short Git commit with `-dirty` when the worktree has changes, or `uncommitted-dirty` before a commit is available. Vite injects the same label when the server/build starts; restart/rebuild after source changes for an updated label. Kernel version `1.1.0` is recorded separately. The benchmark retains JSON candidate histories and actual-run CSV, freezes selection on training conditions, then runs the frozen candidate and matched baseline on the separate held-out map. Explicit current-factory / sustained runs do not silently introduce a different held-out map. New seeds on a training map are not a substitute for a different-map check.

## Presentation and editing

The simulation worker targets 6 ticks/s at 1×, performs at most 12 ticks or about 6ms per work chunk, and caps scheduling debt at 12 ticks. Frame publication targets 50ms and property snapshots 200ms independently. A tick that exceeds the chunk budget must finish atomically; the actual rate is shown rather than dropping simulation ticks. Orders/events/digests are omitted from visual packets and requested only for details or exact control boundaries.

The display buffer holds at most 96 executed frames. A common presentation cursor interpolates only adjacent executed ticks and legal unit moves for every robot; status/cargo/machine markers use that interval's left endpoint. No planned path is interpreted as executed motion. Speeds above 8×, reduced motion and background resume use real discrete samples. Pause/reset/step/seek clear the buffer. Planned routes are explicitly separate overlays. Canvas uses rAF timestamps, a static ground/wall layer cached by scene/view/DPR, and bitmap resizing only for dimension/DPR changes. Its timing arrays have 4,096-entry caps; properties use low-frequency React state.

Editing switches to the initial layout. A complete paint stroke or object move validates and commits once, with 50 bounded undo entries. Preview validates occupancy without constructing a simulation; station/service positions move together. All coordinates and hit tests use the same zoom/pan transform; robot hits use actual displayed positions and IDs. Numeric inputs retain drafts, applying only on Enter or Apply. Invalid input leaves the simulation unchanged.
