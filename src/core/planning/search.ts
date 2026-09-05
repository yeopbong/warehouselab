import { pointKey, samePoint, type Point } from '../model/types';

export interface Grid {
  width: number;
  height: number;
  blocked: ReadonlySet<string>;
}

/** Exact topology identity: changing a wall, station body or dimensions changes the key. */
export function topologyKey(grid: Grid): string {
  return `${grid.width}x${grid.height}:${[...grid.blocked].sort().join(';')}`;
}

// At most 64 fields / 102,400 cells for the supported 40×40 maps. Cache entries contain
// only derived static distances; eviction and worker boundaries cannot affect decisions.
const distanceFields = new Map<string, Int32Array>();
const DISTANCE_FIELD_LIMIT = 64;
const DISTANCE_FIELD_CELLS = 102_400;
let cachedCells = 0;

/** Reverse BFS gives a lower bound on every nonnegative weighted time-space route. */
function staticGoalDistances(grid: Grid, goal: Point): Int32Array {
  const key = `${topologyKey(grid)}>${pointKey(goal)}`;
  const cached = distanceFields.get(key);
  if (cached) {
    distanceFields.delete(key);
    distanceFields.set(key, cached);
    return cached;
  }
  const distances = new Int32Array(grid.width * grid.height).fill(-1);
  if (walkable(grid, goal)) {
    const queue = new Int32Array(distances.length);
    let head = 0,
      tail = 0;
    const goalIndex = goal.y * grid.width + goal.x;
    distances[goalIndex] = 0;
    queue[tail++] = goalIndex;
    while (head < tail) {
      const index = queue[head++];
      const point = { x: index % grid.width, y: Math.floor(index / grid.width) };
      for (const next of neighbors(grid, point)) {
        const nextIndex = next.y * grid.width + next.x;
        if (distances[nextIndex] !== -1) continue;
        distances[nextIndex] = distances[index] + 1;
        queue[tail++] = nextIndex;
      }
    }
  }
  if (distances.length <= DISTANCE_FIELD_CELLS) {
    distanceFields.set(key, distances);
    cachedCells += distances.length;
    while (distanceFields.size > DISTANCE_FIELD_LIMIT || cachedCells > DISTANCE_FIELD_CELLS) {
      const oldest = distanceFields.keys().next().value!;
      cachedCells -= distanceFields.get(oldest)!.length;
      distanceFields.delete(oldest);
    }
  }
  return distances;
}

/** Read-only distance lookup for this topology snapshot. -1 means statically unreachable. */
export function staticDistanceToGoal(grid: Grid, goal: Point): (point: Point) => number {
  const field = staticGoalDistances(grid, goal);
  return (point) => (walkable(grid, point) ? field[point.y * grid.width + point.x] : -1);
}

/** All path arrays contain future cells, excluding the starting cell. */
export interface SearchOptions {
  congestion?: (point: Point) => number;
  congestionWeight?: number;
}

export function walkable(grid: Grid, point: Point): boolean {
  return (
    Number.isInteger(point.x) &&
    Number.isInteger(point.y) &&
    point.x >= 0 &&
    point.y >= 0 &&
    point.x < grid.width &&
    point.y < grid.height &&
    !grid.blocked.has(pointKey(point))
  );
}

export function neighbors(grid: Grid, point: Point, includeWait = false): Point[] {
  const candidates = [
    { x: point.x + 1, y: point.y },
    { x: point.x, y: point.y + 1 },
    { x: point.x - 1, y: point.y },
    { x: point.x, y: point.y - 1 },
  ];
  if (includeWait) candidates.push({ ...point });
  return candidates.filter((candidate) => walkable(grid, candidate));
}

function edgeCost(point: Point, options: SearchOptions): number {
  const weight = options.congestionWeight ?? 0;
  const congestion = options.congestion?.(point) ?? 0;
  if (!Number.isFinite(weight) || weight < 0 || !Number.isFinite(congestion) || congestion < 0) {
    throw new Error('Routing congestion and weight must be finite and nonnegative');
  }
  return 1 + weight * congestion;
}

interface Node {
  point: Point;
  time: number;
  g: number;
  h: number;
  parent?: Node;
  sequence: number;
}

/** Small binary heap with stable tie breaking; iteration order never depends on robot array order. */
class OpenSet {
  private nodes: Node[] = [];
  get size(): number {
    return this.nodes.length;
  }
  private before(a: Node, b: Node): boolean {
    return (
      a.g + a.h < b.g + b.h ||
      (a.g + a.h === b.g + b.h && (a.h < b.h || (a.h === b.h && a.sequence < b.sequence)))
    );
  }
  push(node: Node): void {
    this.nodes.push(node);
    let index = this.nodes.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.before(node, this.nodes[parent])) break;
      this.nodes[index] = this.nodes[parent];
      index = parent;
    }
    this.nodes[index] = node;
  }
  pop(): Node {
    const first = this.nodes[0];
    const last = this.nodes.pop()!;
    if (this.nodes.length) {
      let index = 0;
      while (index * 2 + 1 < this.nodes.length) {
        let child = index * 2 + 1;
        if (child + 1 < this.nodes.length && this.before(this.nodes[child + 1], this.nodes[child]))
          child += 1;
        if (!this.before(this.nodes[child], last)) break;
        this.nodes[index] = this.nodes[child];
        index = child;
      }
      this.nodes[index] = last;
    }
    return first;
  }
}

function unwind(node: Node): Point[] {
  const path: Point[] = [];
  while (node.parent) {
    path.push({ ...node.point });
    node = node.parent;
  }
  return path.reverse();
}

/** Static A*: shortest unit-distance path, or weighted path when congestion is enabled. */
export function aStar(
  grid: Grid,
  start: Point,
  goal: Point,
  options: SearchOptions = {},
): Point[] | null {
  if (!walkable(grid, start) || !walkable(grid, goal)) return null;
  const field = staticGoalDistances(grid, goal);
  const remaining = (point: Point) => field[point.y * grid.width + point.x];
  if (remaining(start) < 0) return null;
  const open = new OpenSet();
  const costs = new Map<string, number>([[pointKey(start), 0]]);
  let sequence = 0;
  open.push({ point: start, time: 0, g: 0, h: remaining(start), sequence: sequence++ });
  while (open.size) {
    const node = open.pop();
    if (node.g !== costs.get(pointKey(node.point))) continue;
    if (samePoint(node.point, goal)) return unwind(node);
    for (const next of neighbors(grid, node.point)) {
      const g = node.g + edgeCost(next, options);
      const key = pointKey(next);
      if (g >= (costs.get(key) ?? Infinity)) continue;
      costs.set(key, g);
      open.push({
        point: next,
        time: node.time + 1,
        g,
        h: remaining(next),
        parent: node,
        sequence: sequence++,
      });
    }
  }
  return null;
}

export interface MotionReservations {
  canMove(owner: string, from: Point, to: Point, arrival: number): boolean;
}
export interface TimedPath {
  path: Point[];
  reachedGoal: boolean;
  explored: number;
}

/** Prioritized time-space A*. Waiting has cost >= 1 and occupies a real cell. */
export function spaceTimeAStar(
  grid: Grid,
  start: Point,
  goal: Point,
  owner: string,
  reservations: MotionReservations,
  horizon: number,
  options: SearchOptions = {},
): TimedPath | null {
  if (!Number.isInteger(horizon) || horizon < 1)
    throw new Error('Planning horizon must be a positive integer');
  if (!walkable(grid, start) || !walkable(grid, goal)) return null;
  const field = staticGoalDistances(grid, goal);
  const remaining = (point: Point) => field[point.y * grid.width + point.x];
  if (remaining(start) < 0) return null;
  const open = new OpenSet();
  const costs = new Map<string, number>([[`${pointKey(start)}@0`, 0]]);
  let sequence = 0;
  let explored = 0;
  let partial: Node | undefined;
  open.push({ point: start, time: 0, g: 0, h: remaining(start), sequence: sequence++ });
  while (open.size) {
    const node = open.pop();
    if (node.g !== costs.get(`${pointKey(node.point)}@${node.time}`)) continue;
    explored += 1;
    if (samePoint(node.point, goal)) {
      let canHold = true;
      for (let time = node.time + 1; time <= horizon; time += 1) {
        if (!reservations.canMove(owner, goal, goal, time)) {
          canHold = false;
          break;
        }
      }
      if (canHold) return { path: unwind(node), reachedGoal: true, explored };
    }
    if (node.time === horizon) {
      // All partial endpoints use the same time: prefer remaining static route distance,
      // then actual routing cost, then insertion order. Never promise an unsafe tail.
      if (!partial || node.h < partial.h || (node.h === partial.h && node.g < partial.g))
        partial = node;
      continue;
    }
    for (const next of neighbors(grid, node.point, true)) {
      const time = node.time + 1;
      if (!reservations.canMove(owner, node.point, next, time)) continue;
      const g = node.g + edgeCost(next, options);
      const key = `${pointKey(next)}@${time}`;
      if (g >= (costs.get(key) ?? Infinity)) continue;
      costs.set(key, g);
      open.push({
        point: next,
        time,
        g,
        h: remaining(next),
        parent: node,
        sequence: sequence++,
      });
    }
  }
  return partial ? { path: unwind(partial), reachedGoal: false, explored } : null;
}
