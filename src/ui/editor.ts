import { samePoint, type Point, type Scenario, type StationRole } from '../core/model/types';
import { validateScenario } from '../core/model/validation';
import type { EditAction } from './CanvasMap';
export const HISTORY_LIMIT = 50;
export function available(scene: Scenario, p: Point): boolean {
  return (
    p.x >= 0 &&
    p.y >= 0 &&
    p.x < scene.width &&
    p.y < scene.height &&
    !scene.obstacles.some((o) => samePoint(o, p)) &&
    !scene.stations.some((s) => samePoint(s.position, p) || samePoint(s.service, p)) &&
    !scene.robots.some((r) => samePoint(r.position, p))
  );
}
function nextId(prefix: string, ids: string[]): string {
  let i = 1;
  while (ids.includes(`${prefix}-${i}`)) i++;
  return `${prefix}-${i}`;
}
/** Lightweight preview validation; no simulation or scene cloning during a pointer gesture. */
export function previewEdit(scene: Scenario, action: EditAction): string | null {
  const inside = (p: Point) =>
    Number.isInteger(p.x) &&
    Number.isInteger(p.y) &&
    p.x >= 0 &&
    p.y >= 0 &&
    p.x < scene.width &&
    p.y < scene.height;
  if (action.type === 'paint') {
    if (action.cells.some((p) => !inside(p))) return 'Keep the stroke inside the factory.';
    if (
      action.tool === 'obstacle' &&
      action.cells.some(
        (p) => !available(scene, p) && !scene.obstacles.some((o) => samePoint(o, p)),
      )
    )
      return 'Walls cannot cover a robot, machine or service cell.';
    return null;
  }
  if (!inside(action.point)) return 'Choose a cell inside the factory.';
  if (action.type === 'move') {
    const selected = action.selection;
    const filtered = {
      ...scene,
      robots: scene.robots.filter((r) => selected.kind !== 'robot' || r.id !== selected.id),
      stations: scene.stations.filter((s) => selected.kind !== 'station' || s.id !== selected.id),
    };
    if (!available(filtered, action.point)) return 'The destination is occupied.';
    if (selected.kind === 'station') {
      const station = scene.stations.find((s) => s.id === selected.id);
      if (!station) return 'Station no longer exists.';
      const service = {
        x: action.point.x + station.service.x - station.position.x,
        y: action.point.y + station.service.y - station.position.y,
      };
      if (!available(filtered, service)) return 'The station service cell needs free space too.';
    }
    return null;
  }
  if (!available(scene, action.point)) return 'Choose a free cell.';
  if (action.tool !== 'robot' && !adjacent(action.point).some((p) => available(scene, p)))
    return 'A machine needs an adjacent free service cell.';
  return null;
}
const adjacent = (p: Point): Point[] => [
  { x: p.x, y: p.y + 1 },
  { x: p.x + 1, y: p.y },
  { x: p.x - 1, y: p.y },
  { x: p.x, y: p.y - 1 },
];
export function applyEdit(scene: Scenario, action: EditAction): Scenario {
  const error = previewEdit(scene, action);
  if (error) throw new Error(error);
  const next = structuredClone(scene);
  if (action.type === 'paint') {
    const cells = new Set(action.cells.map((p) => `${p.x},${p.y}`));
    const hit = (p: Point) => cells.has(`${p.x},${p.y}`);
    if (action.tool === 'obstacle') {
      const existing = new Set(next.obstacles.map((p) => `${p.x},${p.y}`));
      for (const p of action.cells)
        if (!existing.has(`${p.x},${p.y}`)) {
          next.obstacles.push(p);
          existing.add(`${p.x},${p.y}`);
        }
    } else {
      next.obstacles = next.obstacles.filter((p) => !hit(p));
      const removed = new Set(
        next.stations.filter((s) => hit(s.position) || hit(s.service)).map((s) => s.id),
      );
      next.stations = next.stations.filter((s) => !removed.has(s.id));
      next.orders = next.orders.filter((o) => !removed.has(o.destination));
      next.robots = next.robots.filter((r) => !hit(r.position));
      if (!next.stations.some((s) => s.role === 'delivery')) delete next.orderStream;
    }
  } else if (action.type === 'move') {
    const selection = action.selection!;
    if (selection.kind === 'robot')
      next.robots.find((r) => r.id === selection.id)!.position = action.point;
    if (selection.kind === 'station') {
      const station = next.stations.find((s) => s.id === selection.id)!;
      station.service = {
        x: station.service.x + action.point.x - station.position.x,
        y: station.service.y + action.point.y - station.position.y,
      };
      station.position = action.point;
    }
  } else if (action.tool === 'robot') {
    next.robots.push({
      id: nextId(
        'robot',
        next.robots.map((r) => r.id),
      ),
      position: action.point,
    });
  } else {
    const role = action.tool as StationRole;
    const id = nextId(
      role,
      next.stations.map((s) => s.id),
    );
    const recipe = role === 'assembly' ? next.recipes.at(-1) : next.recipes[0];
    next.stations.push({
      id,
      role,
      position: action.point,
      service: adjacent(action.point).find((p) => available(next, p))!,
      inputCapacity: 8,
      outputCapacity: 8,
      ...(role === 'supply'
        ? { supplyItem: Object.keys(next.recipes[0]?.inputs ?? { raw: 1 })[0], supplyInterval: 3 }
        : {}),
      ...((role === 'assembly' || role === 'process') && recipe ? { recipeId: recipe.id } : {}),
    });
    if (role === 'delivery')
      next.orders.push({
        id: nextId(
          'order',
          next.orders.map((o) => o.id),
        ),
        arrival: 0,
        item: next.recipes.at(-1)?.output.item ?? 'product',
        quantity: 3,
        destination: id,
      });
  }
  return validateScenario(next);
}
export function withRobotCount(scene: Scenario, count: number): Scenario {
  if (!Number.isInteger(count) || count < 0 || count > 24)
    throw new Error('Robot count must be an integer from 0 to 24.');
  const next = structuredClone(scene);
  next.robots = next.robots.slice(0, count);
  for (let y = next.height - 1; y >= 0 && next.robots.length < count; y--)
    for (let x = 0; x < next.width && next.robots.length < count; x++) {
      const position = { x, y };
      if (available(next, position))
        next.robots.push({
          id: nextId(
            'robot',
            next.robots.map((r) => r.id),
          ),
          position,
        });
    }
  if (next.robots.length !== count) throw new Error('Not enough free cells for that many robots.');
  return validateScenario(next);
}
