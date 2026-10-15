# Sorting workbench

The default workbench reads actual native simulation records. Public hosting serves saved results; it does not execute native evaluations. Run the local service for new search and evaluation. No account or external API key is needed.

## Native dependencies

On macOS, install command-line developer tools and `brew install cmake boost spdlog libomp`. On Ubuntu, install:

```sh
sudo apt-get install build-essential cmake libboost-program-options-dev libboost-filesystem-dev libboost-log-dev libboost-iostreams-dev libspdlog-dev libomp-dev
```

Follow the Python and npm commands in the [README](../README.md). Linux users can install a CPU-only PyTorch wheel before `pip install -e '.[test]'`:

```sh
pip install 'torch>=2.2,<3' --index-url https://download.pytorch.org/whl/cpu
```

`setup-tmo.py` fetches pinned sources into `.cache/tmo`, applies the runtime patch, and builds `tmo-run`. It keeps upstream files and existing declarations in that local checkout. `--jobs 2` reduces compilation parallelism. Windows native compilation has not been validated.

## Inspect and evaluate

Click an actual point on the search curve to see its mapping, pre-evaluation prediction, independent simulation seeds, calls and elapsed time. Model disagreement is not a calibrated confidence interval. The prediction panel shows 12 spatial zones: navigation waiting excludes loading/unloading; closure is closed chute-ticks divided by the zone's chute-ticks. Residuals are predictive errors, not causal effects.

Select a destination or chute to avoid drawing every destination in a different color. Legal edits can transfer one chute or swap two assignments. Evaluation always starts a new simulation from the initial state. A fixed-mapping test under changed demand retains the assignment and relaxes only the new search quota if needed; reoptimization uses that condition's original quotas.

Use A/B replay to compare actual robot positions, goals, parcel identities, chute closures, reroutes and recirculation. Public records include selected full traces; other candidates retain their measured summaries. Local evaluations record full traces. Export/import preserves experiment records for viewing; imported records do not execute code or load model checkpoints.

Cancel stops after the current native call. Its cost and result remain recorded. A candidate missing any required repetition cannot train the model or become the incumbent. Restarting the service does not resume a running simulator from a checkpoint.

```sh
python -m warehouse_sorting search --scenario sparse-600-721 --method spatial_aux --budget 24 --seeds 11 29 --trace
```

The budget counts native calls, including repetitions. `--batch-size` counts distinct mappings. Six search methods are selectable in the interface; `random` is also available from the CLI. To run browser tests against the production service:

```sh
PW_BASE_URL=http://127.0.0.1:8000 PW_SORTING_LIVE=1 npm run test:e2e
```

## Factory example

Open `/#factory` for the original production/assembly simulator. Its controls and historical experiments below refer to its separate TypeScript kernel, not the native sorting model.


Open the [factory example](https://yeopbong.github.io/warehouselab/#factory) in a modern browser. **Open floor** starts at tick 0; press **Start** to run it. Simulation and policy search run in your browser. For local installation, see the [README](../README.md#run-locally).

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
