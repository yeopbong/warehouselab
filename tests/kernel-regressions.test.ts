import { describe, expect, it } from 'vitest';
import { aStar, planRobotMoves, ReservationTable, spaceTimeAStar } from '../src/core/planning';
import {
  distance,
  pointKey,
  samePoint,
  type Scenario,
  type SimState,
} from '../src/core/model/types';
import { BASELINE, QUEUE_AWARE } from '../src/core/policies/config';
import {
  assertInvariants,
  createSimulation,
  metrics,
  stateDigest,
  step,
} from '../src/core/sim/engine';
import { PRESETS, SUSTAINED } from '../src/scenarios';

function detourFactory(): Scenario {
  return {
    schemaVersion: 1,
    id: 'wall-detour',
    name: 'Wall detour',
    description: '',
    width: 20,
    height: 20,
    seed: 1,
    obstacles: Array.from({ length: 18 }, (_, index) => ({ x: 10, y: index + 1 })),
    robots: [{ id: 'robot', position: { x: 9, y: 10 } }],
    stations: [],
    recipes: [],
    orders: [],
  };
}

const advance = (state: SimState, until: number): SimState => {
  while (state.tick < until) step(state);
  return state;
};

function dispatchFactory(): Scenario {
  return {
    schemaVersion: 1,
    id: 'dispatch-age',
    name: 'Dispatch age',
    description: '',
    width: 7,
    height: 7,
    seed: 1,
    obstacles: [],
    recipes: [],
    stations: [
      {
        id: 'supply',
        role: 'supply',
        position: { x: 1, y: 1 },
        service: { x: 1, y: 2 },
        inputCapacity: 3,
        outputCapacity: 3,
        supplyItem: 'product',
        supplyInterval: 5,
      },
      {
        id: 'a-delivery',
        role: 'delivery',
        position: { x: 5, y: 1 },
        service: { x: 5, y: 2 },
        inputCapacity: 3,
        outputCapacity: 3,
      },
      {
        id: 'z-delivery',
        role: 'delivery',
        position: { x: 5, y: 5 },
        service: { x: 5, y: 4 },
        inputCapacity: 3,
        outputCapacity: 3,
      },
    ],
    robots: [{ id: 'R1', position: { x: 3, y: 3 } }],
    orders: [
      { id: 'old-z', arrival: 0, item: 'product', quantity: 1, destination: 'z-delivery' },
      { id: 'new-a', arrival: 5, item: 'product', quantity: 1, destination: 'a-delivery' },
    ],
  };
}

describe('topology-aware rolling planning', () => {
  it.each([4, 12, 16])(
    'reaches the supplied wall-detour goal with planning window %i',
    (window) => {
      const scenario = detourFactory();
      const grid = { width: 20, height: 20, blocked: new Set(scenario.obstacles.map(pointKey)) };
      const goal = { x: 11, y: 10 };
      expect(aStar(grid, scenario.robots[0].position, goal)).toHaveLength(20);
      const state = createSimulation(scenario, {
        ...BASELINE,
        planningWindow: window,
        replanInterval: 8,
      });
      const trace = [{ ...state.robots[0].position }];
      for (let tick = 0; tick < 40 && !samePoint(state.robots[0].position, goal); tick++) {
        const previous = state.robots[0].position;
        const moves = planRobotMoves(state, new Map([['robot', goal]]));
        const next = moves.get('robot')!;
        expect(distance(previous, next)).toBeLessThanOrEqual(1);
        expect(grid.blocked.has(pointKey(next))).toBe(false);
        state.robots[0].position = next;
        state.tick++;
        trace.push(next);
        assertInvariants(state);
      }
      expect(state.robots[0].position).toEqual(goal);
      expect(trace).toHaveLength(21);
      expect(distance(trace[1], goal)).toBeGreaterThan(distance(trace[0], goal));
    },
  );

  it('reports unreachable targets and invalidates distance fields after topology edits', () => {
    const blocked = new Set(Array.from({ length: 5 }, (_, y) => `2,${y}`));
    const grid = { width: 5, height: 5, blocked };
    const start = { x: 1, y: 2 },
      goal = { x: 3, y: 2 };
    const reservations = new ReservationTable();
    expect(spaceTimeAStar(grid, start, goal, 'r', reservations, 4)).toBeNull();
    blocked.delete('2,0');
    const detour = spaceTimeAStar(grid, start, goal, 'r', reservations, 4)!;
    expect(detour.reachedGoal).toBe(false);
    expect(detour.path[0]).toEqual({ x: 1, y: 1 });
    blocked.delete('2,2');
    expect(spaceTimeAStar(grid, start, goal, 'r', reservations, 4)?.path).toEqual([
      { x: 2, y: 2 },
      goal,
    ]);
    blocked.add('2,2');
    blocked.add('2,0');
    expect(spaceTimeAStar(grid, start, goal, 'r', reservations, 4)).toBeNull();
  });

  it('restores exact path-reuse decisions from structured and JSON checkpoints', () => {
    const state = advance(
      createSimulation(
        PRESETS[1],
        {
          ...QUEUE_AWARE,
          planningWindow: 12,
          replanInterval: 8,
        },
        91,
      ),
      73,
    );
    expect(Object.keys(state.planner.paths).length).toBeGreaterThan(0);
    const clones = [structuredClone(state), JSON.parse(JSON.stringify(state)) as SimState];
    for (let tick = state.tick; tick < 220; tick++) {
      step(state);
      for (const clone of clones) {
        step(clone);
        expect(stateDigest(clone)).toBe(stateDigest(state));
      }
    }
  });
});

describe('global delivery order priority and backlog', () => {
  it.each(['fixed', 'waiting'] as const)(
    'reserves the oldest across stations with robot priority %s',
    (priority) => {
      const state = advance(createSimulation(dispatchFactory(), { ...BASELINE, priority }), 5);
      expect(state.robots[0].tasks[0]?.orderId).toBe('old-z');
      expect(state.orders.find((order) => order.id === 'old-z')?.reserved).toBe(1);
      expect(state.orders.find((order) => order.id === 'new-a')?.reserved).toBe(0);
      expect(metrics(state).oldestUnfinishedAge).toBe(5);
      assertInvariants(state);
    },
  );

  it('skips an oldest order without available stock and uses stable order ID for same-age ties', () => {
    const scenario = dispatchFactory();
    scenario.orders[0].item = 'unavailable';
    const state = advance(createSimulation(scenario, BASELINE), 5);
    expect(state.robots[0].tasks[0]?.orderId).toBe('new-a');
    assertInvariants(state);
    const tied = dispatchFactory();
    tied.orders[1].arrival = 0;
    expect(advance(createSimulation(tied, BASELINE), 5).robots[0].tasks[0]?.orderId).toBe('new-a');
  });

  it('skips a statically unreachable older delivery without tying up the only robot', () => {
    const scenario = dispatchFactory();
    scenario.obstacles = [
      { x: 4, y: 4 },
      { x: 6, y: 4 },
      { x: 5, y: 3 },
    ];
    const state = advance(createSimulation(scenario, BASELINE), 5);
    expect(state.robots[0].tasks[0]?.orderId).toBe('new-a');
    expect(state.orders.find((order) => order.id === 'old-z')?.reserved).toBe(0);
    advance(state, 60);
    expect(state.orders.find((order) => order.id === 'new-a')?.completedAt).not.toBeNull();
    expect(state.orders.find((order) => order.id === 'old-z')?.completedAt).toBeNull();
    assertInvariants(state);
  });

  it('assigns reachable robots and sources in separate components, preserving global age priority', () => {
    const scenario = dispatchFactory();
    scenario.obstacles = Array.from({ length: 7 }, (_, y) => ({ x: 3, y }));
    scenario.stations.find((station) => station.id === 'a-delivery')!.position = { x: 2, y: 5 };
    scenario.stations.find((station) => station.id === 'a-delivery')!.service = { x: 2, y: 4 };
    scenario.stations.push({
      ...scenario.stations[0],
      id: 'right-supply',
      position: { x: 5, y: 1 },
      service: { x: 5, y: 2 },
    });
    // R1 is Manhattan-nearer to the right pickup but is separated from it by the wall.
    scenario.robots = [
      { id: 'R1', position: { x: 2, y: 2 } },
      { id: 'R2', position: { x: 4, y: 6 } },
    ];
    const state = advance(createSimulation(scenario, BASELINE), 5);
    expect(state.robots.find((robot) => robot.id === 'R2')?.tasks[0]).toMatchObject({
      orderId: 'old-z',
      source: 'right-supply',
    });
    expect(state.robots.find((robot) => robot.id === 'R1')?.tasks[0]).toMatchObject({
      orderId: 'new-a',
      source: 'supply',
    });
    advance(state, 80);
    expect(metrics(state).completedOrders).toBe(2);
    assertInvariants(state);
  });

  it('does not let station names starve older cross-station demand', () => {
    const scenario = dispatchFactory();
    scenario.orders = Array.from({ length: 24 }, (_, index) => ({
      id: `order-${String(index).padStart(2, '0')}`,
      arrival: index * 5,
      item: 'product',
      quantity: 1,
      destination: index % 2 ? 'a-delivery' : 'z-delivery',
    }));
    const renamed = structuredClone(scenario);
    const rename = (id: string) =>
      id === 'a-delivery' ? 'z-renamed' : id === 'z-delivery' ? 'a-renamed' : id;
    renamed.stations.forEach((station) => {
      station.id = rename(station.id);
    });
    renamed.orders.forEach((order) => {
      order.destination = rename(order.destination);
    });
    const originalState = advance(createSimulation(scenario, BASELINE), 180);
    const renamedState = advance(createSimulation(renamed, BASELINE), 180);
    expect(
      originalState.orders.map((order) => [order.id, order.completedAt, order.reserved]),
    ).toEqual(renamedState.orders.map((order) => [order.id, order.completedAt, order.reserved]));
    for (const destination of ['a-delivery', 'z-delivery'])
      expect(
        originalState.orders.filter(
          (order) => order.destination === destination && order.completedAt !== null,
        ).length,
      ).toBeGreaterThan(3);
    expect(metrics(originalState).oldestUnfinishedAge).toBeGreaterThan(0);
    advance(originalState, 600);
    expect(metrics(originalState).completedOrders).toBe(24);
    expect(metrics(originalState).oldestUnfinishedAge).toBeNull();
  });

  it('keeps seeded sustained demand active and completes work at both dispatch stations', () => {
    expect(PRESETS[3].id).toBe('heldout-offset');
    expect(PRESETS[4]).toBe(SUSTAINED);
    const initial = createSimulation(SUSTAINED, BASELINE);
    expect(initial.orders).toEqual(createSimulation(SUSTAINED, QUEUE_AWARE).orders);
    const state = advance(initial, 400);
    const before = metrics(state).completedOrders;
    expect(state.orders.some((order) => order.arrival > 1200)).toBe(true);
    expect(metrics(state).unfinishedOrders).toBeGreaterThan(0);
    advance(state, 600);
    expect(metrics(state).completedOrders).toBeGreaterThan(before);
    for (const destination of ['dispatch-1', 'dispatch-2'])
      expect(
        state.orders.some(
          (order) => order.destination === destination && order.completedAt !== null,
        ),
      ).toBe(true);
    expect(metrics(state).oldestUnfinishedAge).toBeGreaterThan(0);
    assertInvariants(state);
    // A full 600-tick / 12-robot invariant check is CPU-bound, not a latency assertion.
    // The Linux CI runner measured 5.86s; retain every tick and assertion on slower runners.
  }, 20_000);
});
