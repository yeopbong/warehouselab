import { describe, expect, it } from 'vitest';
import { PRESETS } from '../src/scenarios';
import { BASELINE, QUEUE_AWARE } from '../src/core/policies/config';
import {
  assertInvariants,
  cancelTask,
  createSimulation,
  metrics,
  step,
} from '../src/core/sim/engine';
import { validateScenario } from '../src/core/model/validation';
import { estimatedFinish } from '../src/core/policies/assignment';

describe('independent material-flow audit regressions', () => {
  it('allocates shared input capacity in complete recipe proportions for multiple ingredients', () => {
    const scenario = structuredClone(PRESETS[0]);
    scenario.orderStream = undefined;
    scenario.orders = [
      { id: 'audit-order', arrival: 0, item: 'product', quantity: 1, destination: 'dispatch-1' },
    ];
    scenario.recipes[0].inputs = { raw: 1, auxiliary: 1 };
    scenario.stations.find((station) => station.id === 'press-1')!.inputCapacity = 2;
    scenario.stations.push({
      id: 'supply-aux',
      role: 'supply',
      position: { x: 2, y: 5 },
      service: { x: 2, y: 6 },
      inputCapacity: 3,
      outputCapacity: 3,
      supplyItem: 'auxiliary',
      supplyInterval: 3,
    });
    const state = createSimulation(scenario, QUEUE_AWARE);
    state.stations.find((station) => station.id === 'supply-1')!.output.raw = 3;
    state.stations.find((station) => station.id === 'supply-aux')!.output.auxiliary = 3;
    state.ledger.supplied = { raw: 3, auxiliary: 3 };
    step(state);
    const incoming = state.robots
      .flatMap((robot) => robot.tasks)
      .filter((task) => task.destination === 'press-1');
    expect(incoming.map((task) => task.item).sort()).toEqual(['auxiliary', 'raw']);
    assertInvariants(state);
    for (let i = 0; i < 350; i += 1) step(state);
    expect(metrics(state).completedOrders).toBe(1);
    expect(state.ledger.consumed.auxiliary).toBeGreaterThanOrEqual(2);
    assertInvariants(state);
  });

  it('cancels loading before pickup without consuming stock or leaving a pending service timer', () => {
    const state = createSimulation(PRESETS[0], BASELINE);
    for (
      let tick = 0;
      tick < 100 && !state.robots.some((robot) => robot.status === 'loading');
      tick += 1
    )
      step(state);
    const robot = state.robots.find((candidate) => candidate.status === 'loading')!;
    expect(robot).toBeDefined();
    const task = robot.tasks[0];
    const source = state.stations.find((station) => station.id === task.source)!;
    const destination = state.stations.find((station) => station.id === task.destination)!;
    const stock = source.output[task.item];
    const reserved = source.reservedOutput[task.item];
    const reservedInput = destination.reservedInput;
    expect(cancelTask(state, task.id)).toBe(true);
    expect(robot.serviceUntil).toBe(0);
    expect(robot.load).toBeNull();
    expect(source.output[task.item]).toBe(stock);
    expect(source.reservedOutput[task.item]).toBe(reserved - task.quantity);
    expect(destination.reservedInput).toBe(reservedInput - task.quantity);
    expect(cancelTask(state, task.id)).toBe(false);
    assertInvariants(state);
    expect(() => step(state)).not.toThrow();
    expect(
      state.robots
        .flatMap((candidate) => candidate.tasks)
        .some((candidate) => candidate.id === task.id),
    ).toBe(false);
    assertInvariants(state);
  });

  it('cancels a queued task while preserving an active loading service and its stock commitment', () => {
    const state = createSimulation(PRESETS[0], QUEUE_AWARE);
    for (
      let tick = 0;
      tick < 150 &&
      !state.robots.some((robot) => robot.status === 'loading' && robot.tasks.length > 1);
      tick += 1
    )
      step(state);
    const robot = state.robots.find(
      (candidate) => candidate.status === 'loading' && candidate.tasks.length > 1,
    )!;
    expect(robot).toBeDefined();
    const current = robot.tasks[0];
    const queued = robot.tasks[1];
    const timer = robot.serviceUntil;
    expect(cancelTask(state, queued.id)).toBe(true);
    expect(robot.tasks[0]).toBe(current);
    expect(robot.serviceUntil).toBe(timer);
    expect(robot.status).toBe('loading');
    assertInvariants(state);
    step(state);
    expect(robot.load).toEqual({ item: current.item, quantity: current.quantity });
    expect(current.phase).toBe('carrying');
    assertInvariants(state);
  });
});

describe('independent validation and policy audit regressions', () => {
  it.each(['constructor', 'toString', '__proto__'])(
    'rejects reserved object key %s at every item entry point',
    (item) => {
      const input = structuredClone(PRESETS[0]);
      input.recipes[0].inputs = Object.fromEntries([[item, 1]]);
      expect(() => validateScenario(input)).toThrow('Invalid scenario');
      const output = structuredClone(PRESETS[0]);
      output.recipes[0].output.item = item;
      expect(() => validateScenario(output)).toThrow('Invalid scenario');
      const supply = structuredClone(PRESETS[0]);
      supply.stations[0].supplyItem = item;
      expect(() => validateScenario(supply)).toThrow('Invalid scenario');
      const order = structuredClone(PRESETS[0]);
      order.orders = [
        { id: 'invalid-item', arrival: 0, item, quantity: 1, destination: 'dispatch-1' },
      ];
      expect(() => validateScenario(order)).toThrow('Invalid scenario');
      const stream = structuredClone(PRESETS[0]);
      stream.orderStream!.item = item;
      expect(() => validateScenario(stream)).toThrow('Invalid scenario');
    },
  );

  it('validates a dense DAG at the recipe limit and still detects a cycle through shared ancestors', () => {
    const scenario = structuredClone(PRESETS[0]);
    scenario.stations = scenario.stations.filter(
      (station) => station.role === 'supply' || station.role === 'delivery',
    );
    scenario.recipes = Array.from({ length: 32 }, (_, index) => ({
      id: `recipe-${index}`,
      inputs:
        index === 0
          ? { raw: 1 }
          : Object.fromEntries(Array.from({ length: index }, (_, input) => [`item${input}`, 1])),
      output: { item: `item${index}`, quantity: 1 },
      duration: 1,
    }));
    expect(validateScenario(scenario).recipes).toHaveLength(32);
    scenario.recipes[0].inputs = { item31: 1 };
    expect(() => validateScenario(scenario)).toThrow('cyclic recipe dependency');
  });

  it('counts only the remaining active loading or unloading service once', () => {
    const state = createSimulation(PRESETS[0], QUEUE_AWARE);
    const robot = state.robots[0];
    state.tick = 20;
    robot.position = { x: 2, y: 3 };
    robot.tasks = [
      {
        id: 'current',
        source: 'supply-1',
        destination: 'press-1',
        item: 'raw',
        quantity: 1,
        assignedTo: robot.id,
        createdAt: 0,
        phase: 'reserved',
      },
    ];
    robot.status = 'loading';
    robot.serviceUntil = 21;
    const next = { source: 'press-1', destination: 'assembly-1' };
    // Current: 1 remaining load + 4 travel + 1 unload. Next: 1 load + 4 travel + 1 unload.
    expect(estimatedFinish(state, robot, next)).toBe(12);
    robot.position = { x: 6, y: 3 };
    robot.tasks[0].phase = 'carrying';
    robot.load = { item: 'raw', quantity: 1 };
    robot.status = 'unloading';
    // Current: 1 remaining unload. Next: 1 load + 4 travel + 1 unload.
    expect(estimatedFinish(state, robot, next)).toBe(7);
  });

  it('distributes residual hotspot demand across every non-hot delivery station', () => {
    const scenario = structuredClone(PRESETS[0]);
    scenario.stations.push(
      {
        id: 'dispatch-2',
        role: 'delivery',
        position: { x: 13, y: 5 },
        service: { x: 12, y: 5 },
        inputCapacity: 3,
        outputCapacity: 3,
      },
      {
        id: 'dispatch-3',
        role: 'delivery',
        position: { x: 15, y: 8 },
        service: { x: 15, y: 7 },
        inputCapacity: 3,
        outputCapacity: 3,
      },
    );
    scenario.orderStream = {
      count: 1000,
      interval: 2,
      pattern: 'hotspot',
      quantity: 1,
      item: 'product',
    };
    const state = createSimulation(scenario, BASELINE, 41);
    const counts = new Map<string, number>();
    for (const order of state.orders)
      counts.set(order.destination, (counts.get(order.destination) ?? 0) + 1);
    expect(counts.get('dispatch-1')).toBeGreaterThan(700);
    expect(counts.get('dispatch-2')).toBeGreaterThan(30);
    expect(counts.get('dispatch-3')).toBeGreaterThan(30);
    expect(state.orders).toEqual(createSimulation(scenario, QUEUE_AWARE, 41).orders);
  });
});
