# Using WarehouseLab

Open [WarehouseLab](https://yeopbong.github.io/warehouselab/) in a modern browser. **Open floor** starts at tick 0; press **Start** to run it. Simulation and policy search run in your browser. For local installation, see the [README](../README.md#run-locally).

The example factory turns raw material into parts, assembles two parts into a product, and delivers it. Orders complete after unloading at the delivery station. At **1× = 6 ticks/second**, robots move slowly enough to follow; choose a faster speed to see production sooner.

## Workbench

| Control | Use |
| --- | --- |
| Start / Pause / Step +1 | Run continuously, pause at an executed tick, or advance one tick. |
| Timeline / Reset | Replay previously executed ticks or return to the initial state. |
| Select | Click a robot or station to inspect tasks, cargo, stock and processing. |
| Map tools | Paint or erase walls; place or move stations and robots. Editing pauses the run and shows the initial layout. A completed edit resets to tick 0. |
| Zoom / Pan / Fit | Scroll to zoom, hold Space and drag to pan, or fit the whole factory. |
| Policy | Change parameters, then choose **Apply policy & reset**. Numeric fields commit with Apply or Enter. |
| File | Create a scene, save/restore locally, or import/export scene and policy JSON. |
| Orders / Log | Inspect orders and recent events. |

Undo/Redo retains 50 edits. Escape cancels an unfinished gesture. Shortcuts outside text fields: **V** select, **H** pan, **W** wall, **E** erase, **M** move, **Ctrl/⌘ Z** undo, **Shift Ctrl/⌘ Z** redo, **Ctrl/⌘ S** save.

Local storage holds one factory for this browser and site. After refreshing, choose **File → Restore**. Export JSON for a backup or to move between devices and the online/local versions.

Complex layouts can congest or deadlock. Large runs may run below the requested speed. Replay uses bounded checkpoints, so seeking far back can take longer. Above 8×, or with reduced motion enabled, animation shows discrete executed states.

## Search and compare

1. Open **Optimize**, choose Random search or Mixed-variable GA, and set the horizon and simulation budget.
2. **Current factory** evaluates your edited scene and seed. **Benchmark set** evaluates the first three built-in maps. Each candidate costs one simulation per map × seed.
3. Start the search. Both methods first evaluate the same two presets, which count toward the budget. The browser defaults to six calls and a 240-tick horizon.
4. Use **Apply candidate to current factory** to load the policy and reset the current layout. **Compare baseline vs candidate** reruns both policies on that layout and seed for the displayed horizon.
5. Export the candidate, search results or comparison to retain the configurations and run conditions.

Policies rank by mean completed orders per tick, then fewer unfinished orders and less traffic waiting. Only complete evaluations can win. Cancelled and failed calls remain in exported results and count toward the budget. Cancellation waits for the current simulation tick to finish.

Random search samples legal configurations independently. GA evolves a population with selection, crossover, mutation and one retained elite. Its initial browser population costs three simulations on one map or nine on the benchmark set; a smaller budget may end before it produces offspring. Either method can select a preset. The recorded small experiments did not find a policy better than both supplied presets.

## Policy parameters

| Parameter | Choices / range | Effect |
| --- | --- | --- |
| `assignment` | `nearest` / `earliest` | Choose the nearest idle robot, or estimate completion time including up to two queued tasks. |
| `priority` | `fixed` / `waiting` | Plan robots by stable ID or consecutive traffic-wait age. |
| `routing` | `distance` / `congestion` | Minimize route distance, or add a cost for observed robot density. |
| `congestionWeight` | 0–5 | Scale the density cost; zero with distance routing. |
| `planningWindow` | 4–32 ticks | Set the space-time planning horizon. |
| `replanInterval` | 1–8 ticks | Reuse valid routes between planning calls. |

Baseline uses `nearest / fixed / distance / 0 / 12 / 3`; Queue aware uses `earliest / waiting / congestion / 1.5 / 16 / 2`.

## Command-line runs

Run one built-in factory or an imported scene:

```sh
npm run headless -- --scenario open-floor --policy baseline --seed 11 --ticks 240
npm run headless -- --input scenarios/open-floor.json --config configs/queue-aware.json --ticks 600
```

Compare both search methods on the fixed benchmark set, a saved factory, or sustained demand:

```sh
npm run benchmark -- --quick
npm run benchmark -- --input scenarios/open-floor.json --horizon 240 --budget 6
npm run benchmark -- --sustained --horizon 600 --budget 4
```

`--quick` uses 240 ticks, evaluation seed 11 and 18 training calls per method. It selects on Open floor, Crossroads and Hotspot dispatch, then runs the selected policy and a matched baseline on Held-out offset floor: 38 calls in total. `--full` uses 600 ticks, evaluation seeds 11/29/47, optimizer seeds 7/19/43 and 144 training calls per method per optimizer seed, plus two held-out calls. Current-factory and sustained runs use only their selected scene.

The original maps have finite order batches. Sustained production has 12 robots and 2,000 seeded orders arriving at five-tick intervals through approximately tick 10,000. No warm-up period is excluded. Run records include scene content, policy, seed, horizon, metrics, hashes and code/kernel versions; see the [recorded experiments](design.md#recorded-experiments).

## Development checks

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

`npm run validate` also runs the quick benchmark. `npm run preview` serves the production build. Set `PW_CHANNEL=chrome` to test with installed Chrome, or `PW_BASE_URL` to test an existing production server. For a subpath deployment, set `VITE_BASE_PATH=/warehouselab/` when building.
