import { createSimulationRuntime } from './simulation-runtime';
import type { SimulationCommand } from './simulation-protocol';
const runtime = createSimulationRuntime((message) => self.postMessage(message));
self.onmessage = (event: MessageEvent<SimulationCommand>) => {
  void runtime.handle(event.data);
};
