# WarehouseLab

WarehouseLab is a multi-robot factory simulator with layout editing, replay, and policy search. Build a grid-based factory, move materials through a two-stage production chain, and inspect queues, inventory, robot traffic, and completed orders.

![WarehouseLab factory editor and simulation controls](docs/workbench.png)

## Features

- Edit walls, stations, and robots with drag tools, Undo/Redo, and JSON import/export.
- Run, pause, step, and replay executed ticks; inspect robot tasks and production metrics.
- Compare dispatch and routing policies, or search their parameters with random search and a basic mixed-variable genetic algorithm.
- Reproduce runs through the browser or Node CLI using the same deterministic TypeScript kernel, recorded seeds, and scene configurations.

The application runs locally without an account, database, or application server.

## Run locally

Install **Node.js 22.12 or newer** and npm, then run:

```sh
git clone https://github.com/yeopbong/warehouselab.git
cd warehouselab
npm ci
npm run dev
```

Open the URL printed by Vite, normally `http://127.0.0.1:5173`. Select **Start** to run the initial factory. For a production build, run `npm run build`, then `npm run preview`.

## Limits and documentation

Complex layouts can produce congestion or deadlocks; the planner does not guarantee deadlock freedom. Large maps and long runs cost more computation. The supplied experiments do **not** establish that the genetic algorithm outperforms the preset policies. Original examples have finite order batches; a separate sustained-demand scene extends the workload.

See the [usage guide](docs/usage.md) for controls, policy parameters, CLI commands, and benchmark settings. [Design](docs/design.md) and [planning notes](docs/planning-notes.md) describe the model and algorithms. [Validation](docs/validation.md) links experiment results and their source versions; [performance measurements](docs/performance.md) document browser timing and its limitations.

Project code is available under the [MIT license](LICENSE). See [third-party sources](THIRD_PARTY.md) for dependencies and references.
