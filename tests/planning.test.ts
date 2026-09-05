import { describe, expect, it } from 'vitest';
import {
  aStar,
  planRobotMoves,
  ReservationTable,
  spaceTimeAStar,
  validateSimultaneousMoves,
  type Grid,
} from '../src/core/planning';
import { BASELINE } from '../src/core/policies/config';
import { distance, pointKey, type Point, type Robot, type SimState } from '../src/core/model/types';

const grid = (width: number, height: number, blocked: Point[] = []): Grid => ({
  width,
  height,
  blocked: new Set(blocked.map(pointKey)),
});
function stateFor(positions: Point[], width = 8, height = 6): SimState {
  const robots: Robot[] = positions.map((position, i) => ({
    id: String.fromCharCode(97 + i),
    position: { ...position },
    home: { ...position },
    status: 'idle',
    tasks: [],
    load: null,
    waitReason: '',
    waitTicks: 0,
    totalWaitTicks: 0,
    path: [],
    pathPlannedAt: -1,
    serviceUntil: 0,
  }));
  return {
    scenario: {
      schemaVersion: 1,
      id: 'planning-test',
      name: 'Planning test',
      description: '',
      width,
      height,
      obstacles: [],
      stations: [],
      robots: robots.map(({ id, position }) => ({ id, position })),
      recipes: [],
      orders: [],
      seed: 1,
    },
    config: { ...BASELINE },
    seed: 1,
    tick: 0,
    robots,
    stations: [],
    orders: [],
    ledger: { supplied: {}, consumed: {}, produced: {}, delivered: {} },
    events: [],
    heatmap: {},
    lastProgressTick: 0,
    stalledTicks: 0,
    warning: null,
    nextTaskId: 0,
    planningMs: 0,
    planner: { topology: '', paths: {} },
  };
}
function step(state: SimState, goals: Map<string, Point>): Map<string, Point> {
  const previous = new Map(state.robots.map((robot) => [robot.id, { ...robot.position }]));
  const moves = planRobotMoves(state, goals);
  expect(new Set([...moves.values()].map(pointKey)).size).toBe(state.robots.length);
  for (const robot of state.robots) {
    const next = moves.get(robot.id)!;
    expect(distance(robot.position, next)).toBeLessThanOrEqual(1);
    expect(state.scenario.obstacles.map(pointKey)).not.toContain(pointKey(next));
    for (const other of state.robots)
      if (other.id !== robot.id && pointKey(next) === pointKey(other.position)) {
        expect(pointKey(moves.get(other.id)!)).not.toBe(pointKey(other.position));
        expect(pointKey(moves.get(other.id)!)).not.toBe(pointKey(robot.position));
      }
  }
  for (const robot of state.robots) {
    robot.position = moves.get(robot.id)!;
    robot.waitTicks =
      pointKey(previous.get(robot.id)!) === pointKey(robot.position) ? robot.waitTicks + 1 : 0;
  }
  state.tick += 1;
  return moves;
}

describe('static and time-space A*', () => {
  it('finds a legal shortest detour, and rejects unreachable and blocked targets', () => {
    const map = grid(5, 3, [{ x: 2, y: 1 }]);
    const path = aStar(map, { x: 0, y: 1 }, { x: 4, y: 1 })!;
    expect(path).toHaveLength(6);
    expect(path.at(-1)).toEqual({ x: 4, y: 1 });
    let previous = { x: 0, y: 1 };
    for (const cell of path) {
      expect(distance(previous, cell)).toBe(1);
      previous = cell;
    }
    expect(aStar(grid(3, 1, [{ x: 1, y: 0 }]), { x: 0, y: 0 }, { x: 2, y: 0 })).toBeNull();
    expect(aStar(map, { x: 0, y: 1 }, { x: 2, y: 1 })).toBeNull();
    expect(aStar(map, { x: 0, y: 1 }, { x: 0, y: 1 })).toEqual([]);
  });

  it('uses legal waits while another robot crosses and keeps an occupied goal occupied', () => {
    const table = new ReservationTable();
    expect(
      table.reservePath(
        'b',
        { x: 1, y: 0 },
        [
          { x: 1, y: 1 },
          { x: 2, y: 1 },
        ],
        3,
      ),
    ).toBe(true);
    const route = spaceTimeAStar(grid(3, 2), { x: 0, y: 1 }, { x: 1, y: 1 }, 'a', table, 3)!;
    expect(route.reachedGoal).toBe(true);
    expect(route.path).toEqual([
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ]);
    const held = new ReservationTable();
    held.reservePath('stayer', { x: 4, y: 0 }, [], 4);
    const partial = spaceTimeAStar(grid(5, 1), { x: 0, y: 0 }, { x: 4, y: 0 }, 'a', held, 4)!;
    expect(partial.reachedGoal).toBe(false);
    expect(partial.path).toHaveLength(4);
    expect(partial.path.at(-1)).toEqual({ x: 3, y: 0 });
    expect(partial.path).not.toContainEqual({ x: 4, y: 0 });
  });

  it('returns a safe partial path toward a goal beyond the window', () => {
    const route = spaceTimeAStar(
      grid(20, 1),
      { x: 0, y: 0 },
      { x: 19, y: 0 },
      'a',
      new ReservationTable(),
      4,
    )!;
    expect(route.reachedGoal).toBe(false);
    expect(route.path).toEqual([1, 2, 3, 4].map((x) => ({ x, y: 0 })));
  });

  it('changes routing with nonnegative congestion costs without changing movement rules', () => {
    const map = grid(5, 3);
    const start = { x: 0, y: 1 },
      goal = { x: 4, y: 1 };
    expect(aStar(map, start, goal)).toHaveLength(4);
    const detour = aStar(map, start, goal, {
      congestionWeight: 2,
      congestion: (p) => (p.y === 1 && p.x > 0 && p.x < 4 ? 2 : 0),
    })!;
    expect(detour).toHaveLength(6);
    expect(() => aStar(map, start, goal, { congestionWeight: -1 })).toThrow(/nonnegative/);
    expect(() => aStar(map, start, goal, { congestion: () => -1 })).toThrow(/nonnegative/);
  });
});

describe('owned reservations', () => {
  it('releases only one owner from the requested future tick and preserves all other reservations', () => {
    const table = new ReservationTable();
    table.reservePath(
      'a',
      { x: 0, y: 0 },
      [
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ],
      4,
    );
    table.reservePath('b', { x: 2, y: 1 }, [], 4);
    expect(table.canMove('b', { x: 1, y: 0 }, { x: 0, y: 0 }, 1)).toBe(false);
    table.release('a', 2);
    expect(table.vertexOwner({ x: 1, y: 0 }, 1)).toBe('a');
    expect(table.vertexOwner({ x: 2, y: 0 }, 2)).toBeUndefined();
    expect(table.edgeOwner({ x: 1, y: 0 }, { x: 2, y: 0 }, 2)).toBeUndefined();
    expect(table.vertexOwner({ x: 2, y: 1 }, 4)).toBe('b');
    table.release('a');
    expect(
      table.reservePath(
        'a',
        { x: 0, y: 0 },
        [
          { x: 0, y: 1 },
          { x: 1, y: 1 },
        ],
        4,
      ),
    ).toBe(true);
    expect(table.vertexOwner({ x: 1, y: 1 }, 4)).toBe('a');
    expect(table.vertexOwner({ x: 2, y: 1 }, 4)).toBe('b');
  });

  it('fails conflicting insertion atomically, including endpoint occupancy', () => {
    const table = new ReservationTable();
    table.reservePath('b', { x: 2, y: 0 }, [], 4);
    expect(
      table.reservePath(
        'a',
        { x: 0, y: 0 },
        [
          { x: 1, y: 0 },
          { x: 2, y: 0 },
        ],
        4,
      ),
    ).toBe(false);
    expect(table.vertexOwner({ x: 0, y: 0 }, 0)).toBeUndefined();
    expect(table.vertexOwner({ x: 1, y: 0 }, 1)).toBeUndefined();
    expect(table.vertexOwner({ x: 2, y: 0 }, 4)).toBe('b');
  });
});

describe('simultaneous motion safety', () => {
  it('prevents vertex collisions, swaps, illegal moves, and cascaded entry into stayers', () => {
    const robots = stateFor([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ]).robots;
    const original = new Map(robots.map((r) => [r.id, r.position]));
    expect(
      validateSimultaneousMoves(
        robots,
        new Map([
          ['a', { x: 1, y: 0 }],
          ['b', { x: 0, y: 0 }],
        ]),
      ),
    ).toEqual(original);
    expect(
      validateSimultaneousMoves(
        robots,
        new Map([
          ['a', { x: 1, y: 0 }],
          ['b', { x: 2, y: 0 }],
        ]),
      ),
    ).toEqual(original);
    expect(validateSimultaneousMoves(robots, new Map([['a', { x: 1, y: 1 }]]))).toEqual(original);
    expect(validateSimultaneousMoves(robots, new Map([['a', { x: 0.5, y: 0 }]]))).toEqual(original);
    const competing = stateFor([
      { x: 0, y: 1 },
      { x: 1, y: 0 },
    ]).robots;
    expect(
      validateSimultaneousMoves(
        competing,
        new Map([
          ['a', { x: 1, y: 1 }],
          ['b', { x: 1, y: 1 }],
        ]),
      ),
    ).toEqual(new Map(competing.map((r) => [r.id, r.position])));
  });

  it('allows a following move into a cell whose occupant actually leaves', () => {
    const robots = stateFor([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]).robots;
    const moves = new Map([
      ['a', { x: 1, y: 0 }],
      ['b', { x: 2, y: 0 }],
    ]);
    expect(validateSimultaneousMoves(robots, moves)).toEqual(moves);
  });

  it.each([4, 8, 16, 32])(
    'stays safe under rolling replanning with window %i and occupied goals',
    (window) => {
      const state = stateFor(
        [
          { x: 0, y: 2 },
          { x: 3, y: 0 },
          { x: 6, y: 2 },
          { x: 3, y: 4 },
          { x: 5, y: 4 },
        ],
        7,
        5,
      );
      state.config.planningWindow = window;
      const goals = new Map([
        ['a', { x: 6, y: 2 }],
        ['b', { x: 3, y: 4 }],
        ['c', { x: 0, y: 2 }],
        ['d', { x: 5, y: 4 }],
      ]);
      for (let tick = 0; tick < 30; tick += 1) {
        if (tick === 10) {
          goals.set('c', { x: 6, y: 0 });
          state.config.planningWindow = 4;
        }
        step(state, goals);
        expect(state.robots.find((r) => r.id === 'e')!.position).toEqual({ x: 5, y: 4 });
      }
    },
  );
});

describe('policy effects and path lifecycle', () => {
  it('gives fixed and waiting priorities different winners at an intersection', () => {
    const fixed = stateFor(
      [
        { x: 0, y: 1 },
        { x: 1, y: 0 },
      ],
      3,
      3,
    );
    const waiting = structuredClone(fixed);
    waiting.config.priority = 'waiting';
    waiting.robots[1].waitTicks = 10;
    const goals = new Map([
      ['a', { x: 2, y: 1 }],
      ['b', { x: 1, y: 2 }],
    ]);
    expect(step(fixed, goals).get('a')).toEqual({ x: 1, y: 1 });
    expect(step(waiting, goals).get('b')).toEqual({ x: 1, y: 1 });
  });

  it('uses observable congestion to change the selected route', () => {
    const plain = stateFor(
      [
        { x: 0, y: 1 },
        { x: 2, y: 0 },
        { x: 3, y: 0 },
      ],
      6,
      3,
    );
    const congestion = structuredClone(plain);
    congestion.config = { ...congestion.config, routing: 'congestion', congestionWeight: 5 };
    const goals = new Map([['a', { x: 5, y: 1 }]]);
    step(plain, goals);
    step(congestion, goals);
    expect(plain.robots[0].path.every((p) => p.y === 1)).toBe(true);
    expect(congestion.robots[0].path.some((p) => p.y === 2)).toBe(true);
  });

  it('honors the replan interval, but invalidates changed goals, windows, and blocked paths immediately', () => {
    const state = stateFor([{ x: 0, y: 1 }], 20, 4);
    state.config.replanInterval = 3;
    const goals = new Map([['a', { x: 19, y: 1 }]]);
    const plannedAt: number[] = [];
    for (let tick = 0; tick < 4; tick += 1) {
      step(state, goals);
      plannedAt.push(state.robots[0].pathPlannedAt);
    }
    expect(plannedAt).toEqual([0, 0, 0, 3]);
    goals.set('a', { x: 4, y: 3 });
    step(state, goals);
    expect(state.robots[0].pathPlannedAt).toBe(4);
    expect(state.robots[0].position).toEqual({ x: 4, y: 2 });
    state.config.planningWindow = 4;
    state.scenario.obstacles.push({ x: 4, y: 3 });
    goals.set('a', { x: 6, y: 3 });
    step(state, goals);
    expect(state.robots[0].pathPlannedAt).toBe(5);
    const nextCell = state.robots[0].path[0];
    expect(nextCell).toBeDefined();
    state.scenario.obstacles.push(nextCell);
    step(state, goals);
    expect(state.robots[0].pathPlannedAt).toBe(6);
  });

  it('rolls a short horizon forward even when the configured replan interval is longer', () => {
    const state = stateFor([{ x: 0, y: 0 }], 20, 1);
    state.config.planningWindow = 4;
    state.config.replanInterval = 8;
    const goals = new Map([['a', { x: 19, y: 0 }]]);
    for (let i = 0; i < 19; i += 1) step(state, goals);
    expect(state.robots[0].position).toEqual({ x: 19, y: 0 });
  });

  it('produces identical trajectories when the robot array order is reversed', () => {
    const forward = stateFor(
      [
        { x: 0, y: 2 },
        { x: 3, y: 0 },
        { x: 6, y: 2 },
      ],
      7,
      5,
    );
    const reverse = structuredClone(forward);
    reverse.robots.reverse();
    const goals = new Map([
      ['a', { x: 6, y: 2 }],
      ['b', { x: 3, y: 4 }],
      ['c', { x: 0, y: 2 }],
    ]);
    for (let i = 0; i < 15; i += 1) {
      const a = [...step(forward, goals)].sort(([x], [y]) => x.localeCompare(y));
      const b = [...step(reverse, goals)].sort(([x], [y]) => x.localeCompare(y));
      expect(a).toEqual(b);
    }
  });

  it('leaves positions and non-planning state untouched until the kernel commits moves', () => {
    const state = stateFor([{ x: 0, y: 1 }]);
    const before = structuredClone(state);
    const moves = planRobotMoves(state, new Map([['a', { x: 5, y: 1 }]]));
    expect(moves.get('a')).toEqual({ x: 1, y: 1 });
    expect(state.robots[0].position).toEqual(before.robots[0].position);
    expect(state.planningMs).toBeGreaterThanOrEqual(0);
    state.planningMs = before.planningMs;
    state.robots[0].path = before.robots[0].path;
    state.robots[0].pathPlannedAt = before.robots[0].pathPlannedAt;
    state.planner = before.planner;
    expect(state).toEqual(before);
  });
});
