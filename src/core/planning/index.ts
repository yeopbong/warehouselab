import {
  distance,
  pointKey,
  samePoint,
  type Point,
  type Robot,
  type SimState,
} from '../model/types';
import { ReservationTable } from './reservations';
import { spaceTimeAStar, topologyKey, walkable, type Grid } from './search';

export { aStar, spaceTimeAStar, staticDistanceToGoal, topologyKey, walkable } from './search';
export type { Grid, SearchOptions, TimedPath } from './search';
export { ReservationTable } from './reservations';

/** Safety backstop for simultaneously proposed actions. No array-order physical effects. */
export function validateSimultaneousMoves(
  robots: readonly Pick<Robot, 'id' | 'position'>[],
  proposals: ReadonlyMap<string, Point>,
  grid?: Grid,
): Map<string, Point> {
  const occupants = new Map<string, string>();
  const moves = new Map<string, Point>();
  const robotMap = new Map(robots.map((robot) => [robot.id, robot]));
  if (robotMap.size !== robots.length) throw new Error('Robot IDs must be unique');
  for (const robot of robots) {
    if (occupants.has(pointKey(robot.position)))
      throw new Error('Robots already occupy the same cell');
    occupants.set(pointKey(robot.position), robot.id);
    const proposal = proposals.get(robot.id) ?? robot.position;
    const legal =
      Number.isInteger(proposal.x) &&
      Number.isInteger(proposal.y) &&
      distance(robot.position, proposal) <= 1 &&
      (!grid || walkable(grid, proposal));
    moves.set(robot.id, { ...(legal ? proposal : robot.position) });
  }
  let changed = true;
  const hold = (id: string): void => {
    const robot = robotMap.get(id)!;
    if (!samePoint(moves.get(id)!, robot.position)) {
      moves.set(id, { ...robot.position });
      changed = true;
    }
  };
  while (changed) {
    changed = false;
    const destinations = new Map<string, string[]>();
    for (const [id, destination] of moves) {
      const key = pointKey(destination);
      destinations.set(key, [...(destinations.get(key) ?? []), id]);
    }
    for (const ids of destinations.values()) if (ids.length > 1) ids.forEach(hold);
    for (const robot of robots) {
      const destination = moves.get(robot.id)!;
      if (samePoint(destination, robot.position)) continue;
      const occupantId = occupants.get(pointKey(destination));
      if (!occupantId) continue;
      const occupant = robotMap.get(occupantId)!;
      const occupantMove = moves.get(occupantId)!;
      if (samePoint(occupantMove, occupant.position)) hold(robot.id);
      else if (samePoint(occupantMove, robot.position)) {
        hold(robot.id);
        hold(occupantId);
      }
    }
  }
  return moves;
}

function validCachedPath(grid: Grid, start: Point, path: readonly Point[]): boolean {
  let previous = start;
  for (const cell of path) {
    if (!walkable(grid, cell) || distance(previous, cell) > 1) return false;
    previous = cell;
  }
  return true;
}

/**
 * Plans from one position snapshot, consumes the first path cell, and returns all next positions.
 * Mutates robot.path/pathPlannedAt, serializable planner reuse state and diagnostic planningMs.
 */
export function planRobotMoves(state: SimState, goals: Map<string, Point>): Map<string, Point> {
  const started = performance.now();
  const horizon = state.config.planningWindow;
  const grid: Grid = {
    width: state.scenario.width,
    height: state.scenario.height,
    blocked: new Set(
      [
        ...state.scenario.obstacles,
        ...state.scenario.stations.map((station) => station.position),
      ].map(pointKey),
    ),
  };
  const table = new ReservationTable();
  const proposals = new Map<string, Point>();
  const topology = topologyKey(grid);
  if (state.planner.topology !== topology) state.planner = { topology, paths: {} };
  const metadata = state.planner.paths;
  // A scenario can remove robots between calls; semantic metadata never grows beyond the fleet.
  for (const id of Object.keys(metadata))
    if (!state.robots.some((robot) => robot.id === id)) delete metadata[id];
  const configKey = JSON.stringify(state.config);
  const ordered = [...state.robots].sort(
    (a, b) =>
      (state.config.priority === 'waiting' ? b.waitTicks - a.waitTicks : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  // Pessimistic full-horizon occupancy prevents an unplanned, failed, or idle robot disappearing.
  for (const robot of ordered) {
    if (!table.reservePath(robot.id, robot.position, [], horizon))
      throw new Error('Invalid initial robot occupancy');
  }
  // Observable density around the current positions. Static obstacles do not create extra cost.
  const congestion = new Map<string, number>();
  for (const robot of ordered) {
    for (let dx = -1; dx <= 1; dx += 1)
      for (let dy = -1; dy <= 1; dy += 1) {
        if (Math.abs(dx) + Math.abs(dy) > 1) continue;
        const key = pointKey({ x: robot.position.x + dx, y: robot.position.y + dy });
        congestion.set(key, (congestion.get(key) ?? 0) + (dx === 0 && dy === 0 ? 1 : 0.5));
      }
  }
  for (const robot of ordered) {
    const goal = goals.get(robot.id);
    table.release(robot.id);
    if (!goal || samePoint(robot.position, goal)) {
      robot.path = [];
      delete metadata[robot.id];
      if (!table.reservePath(robot.id, robot.position, [], horizon))
        throw new Error('Stationary robot lost its reserved position');
      proposals.set(robot.id, { ...robot.position });
      continue;
    }
    const old = Object.hasOwn(metadata, robot.id) ? metadata[robot.id] : undefined;
    const reuse =
      old?.goal === pointKey(goal) &&
      old.config === configKey &&
      state.tick - robot.pathPlannedAt < state.config.replanInterval &&
      robot.path.length > 0 &&
      validCachedPath(grid, robot.position, robot.path) &&
      table.reservePath(robot.id, robot.position, robot.path, horizon);
    if (!reuse) {
      const result = spaceTimeAStar(grid, robot.position, goal, robot.id, table, horizon, {
        congestionWeight: state.config.routing === 'congestion' ? state.config.congestionWeight : 0,
        congestion: (point) => congestion.get(pointKey(point)) ?? 0,
      });
      robot.path = result?.path ?? [];
      robot.pathPlannedAt = state.tick;
      Object.defineProperty(metadata, robot.id, {
        value: { goal: pointKey(goal), config: configKey },
        configurable: true,
        enumerable: true,
        writable: true,
      });
      if (!table.reservePath(robot.id, robot.position, robot.path, horizon)) {
        throw new Error(`Planner returned an unreservable path for ${robot.id}`);
      }
    }
    proposals.set(robot.id, { ...(robot.path[0] ?? robot.position) });
  }
  const moves = validateSimultaneousMoves(state.robots, proposals, grid);
  for (const robot of state.robots) {
    if (samePoint(moves.get(robot.id)!, proposals.get(robot.id)!)) {
      if (robot.path.length) robot.path = robot.path.slice(1);
    } else {
      robot.path = [];
      delete metadata[robot.id];
    }
  }
  state.planningMs += performance.now() - started;
  return moves;
}
