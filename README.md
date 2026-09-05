# WarehouseLab

[**Open WarehouseLab**](https://yeopbong.github.io/warehouselab/) — no account, installation, or API key needed. Press **Start** to run the example factory.

WarehouseLab is a multi-robot factory simulator with layout editing, replay, and policy search. Move materials through a two-stage production chain and inspect queues, inventory, traffic, and completed orders.

![WarehouseLab factory editor and simulation controls](docs/workbench.png)

## Features

- Edit walls, stations, and robots with drag tools, Undo/Redo, and JSON import/export.
- Run, pause, step, and replay executed ticks; inspect robot tasks and production metrics.
- Adjust task assignment, traffic priority, route cost, congestion weight, planning window, and replanning interval.
- Compare preset or searched policies using the same deterministic TypeScript kernel in the browser and Node CLI.

Search ranks complete simulations by mean completed orders per tick, then fewer unfinished orders and less traffic waiting. Random search samples configurations; the mixed-variable GA selects, crosses, and mutates configurations using these results. Both first evaluate the same two presets, which count toward the budget. A selected candidate may therefore be a preset.

## Run locally

Install **Node.js 22.12 or newer** and npm, then run:

```sh
git clone https://github.com/yeopbong/warehouselab.git
cd warehouselab
npm ci
npm run dev
```

Open the printed URL, normally `http://127.0.0.1:5173`. For a production build, run `npm run build`, then `npm run preview`.

## Limits and documentation

Complex layouts can produce congestion or deadlocks, and large runs cost more computation. Original examples have finite order batches. The supplied experiments do **not** establish GA superiority: the quick run matched baseline throughput, and both searches selected the supplied queue-aware policy in the sustained-demand run.

See [usage](docs/usage.md) for controls, saving, search budgets, and CLI commands; [design](docs/design.md) and [planning notes](docs/planning-notes.md) for methods; and [validation and results](docs/validation.md) and [performance measurements](docs/performance.md) for recorded conditions and limitations.

Project code is available under the [MIT license](LICENSE). See [third-party sources](THIRD_PARTY.md) for dependencies and references.
