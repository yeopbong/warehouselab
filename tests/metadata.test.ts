import { it, expect } from 'vitest';
import { PRESETS } from '../src/scenarios';
import { BASELINE } from '../src/core/policies/config';
import { createSimulation, step, stateDigest } from '../src/core/sim/engine';
it('serializes path reuse for every legal stable robot ID, including prototype names', () => {
  const scene = structuredClone(PRESETS[0]);
  delete scene.orderStream;
  scene.orders = [
    { id: 'order-1', arrival: 0, item: 'product', quantity: 1, destination: 'dispatch-1' },
  ];
  scene.robots = [{ id: '__proto__', position: { x: 2, y: 10 } }];
  const state = createSimulation(scene, BASELINE);
  for (let i = 0; i < 5; i++) step(state);
  expect(Object.hasOwn(state.planner.paths, '__proto__')).toBe(true);
  const restored = JSON.parse(JSON.stringify(state));
  for (let i = 0; i < 60; i++) {
    step(state);
    step(restored);
    expect(stateDigest(restored)).toBe(stateDigest(state));
  }
});
