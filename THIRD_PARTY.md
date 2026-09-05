# Third-party software and references

WarehouseLab's grid model, production and inventory logic, dispatch policies, A* and space-time planning, reservation table, simultaneous-motion guard, mixed-variable GA, random search, and experiment bookkeeping are implemented in this repository. No external robotics simulator or optimization library supplies those rules. The project does not claim to reproduce the referenced papers or introduce a new algorithm.

## Reused software

| Package / tool | Use | Upstream license |
| --- | --- | --- |
| [React and React DOM](https://github.com/facebook/react) | UI state and controls | MIT |
| [TypeScript](https://github.com/microsoft/TypeScript) | Strict static checking | Apache-2.0 |
| [Vite](https://github.com/vitejs/vite) and [React plugin](https://github.com/vitejs/vite-plugin-react) | Development server, worker bundling, static build | MIT |
| [Vitest](https://github.com/vitest-dev/vitest) | Core and integration tests | MIT |
| [Playwright](https://github.com/microsoft/playwright) | Browser workflow validation | Apache-2.0 |
| [tsx](https://github.com/privatenumber/tsx) | TypeScript command-line execution | MIT |
| [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) types | Node and React type declarations | MIT |

Canvas 2D, Web Workers, structured cloning, and browser local storage are platform APIs. Exact dependency versions and the transitive dependency graph are recorded in `package-lock.json`. Dependencies retain their upstream notices and licenses; the repository's MIT license applies to its own code and does not relicense third-party software.

## Implementation documentation

- [Vite: Deploying a Static Site](https://vite.dev/guide/static-deploy.html) — build output and local preview conventions.
- [MDN: Using Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers) — worker construction and message passing for computation outside the UI thread.

## Related work and inspiration

- [Guidance Graph Optimization for Lifelong Multi-Agent Path Finding](https://arxiv.org/abs/2402.01446) — context for optimizing routing guidance in repeated multi-agent transport.
- [Online Guidance Graph Optimization](https://arxiv.org/abs/2411.16506) — context for adapting routing guidance over time.
- [Factorio Friday Facts #374: Smarter robots](https://factorio.com/blog/post/fff-374) — inspiration for bounded robot task queues and completion-time estimates. Factorio's flying robots are not a basis for WarehouseLab's ground-robot collision rules.

WarehouseLab optimizes a small set of dispatch and planning parameters, rather than reproducing those guidance-graph systems. The GA is a basic mixed-variable implementation. Measured smoke results are presented without claims of statistical significance, generalization, novelty, or guaranteed improvement.
