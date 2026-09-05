import type { Scenario, StationSpec } from '../core/model/types';
const station = (
  id: string,
  role: StationSpec['role'],
  x: number,
  y: number,
  sy: number,
): StationSpec => ({
  id,
  role,
  position: { x, y },
  service: { x, y: sy },
  inputCapacity: role === 'assembly' ? 4 : 3,
  outputCapacity: 3,
  ...(role === 'supply' ? { supplyItem: 'raw', supplyInterval: 3 } : {}),
  ...(role === 'process' ? { recipeId: 'press' } : {}),
  ...(role === 'assembly' ? { recipeId: 'assemble' } : {}),
});
const base: Scenario = {
  schemaVersion: 1,
  id: 'open-floor',
  name: 'Open floor',
  description: 'A small two-stage factory with open aisles and three robots.',
  width: 16,
  height: 12,
  seed: 41,
  obstacles: [],
  stations: [
    station('supply-1', 'supply', 2, 2, 3),
    station('press-1', 'process', 6, 2, 3),
    station('assembly-1', 'assembly', 10, 2, 3),
    station('dispatch-1', 'delivery', 13, 8, 7),
  ],
  robots: [
    { id: 'R1', position: { x: 2, y: 10 } },
    { id: 'R2', position: { x: 5, y: 10 } },
    { id: 'R3', position: { x: 8, y: 10 } },
  ],
  recipes: [
    { id: 'press', inputs: { raw: 1 }, output: { item: 'part', quantity: 1 }, duration: 5 },
    { id: 'assemble', inputs: { part: 2 }, output: { item: 'product', quantity: 1 }, duration: 9 },
  ],
  orders: [],
  orderStream: { count: 20, interval: 28, pattern: 'uniform', quantity: 1, item: 'product' },
};
const crossing: Scenario = {
  ...structuredClone(base),
  id: 'crossroads',
  name: 'Crossroads',
  description: 'Crossing traffic through a central two-cell opening, with finite buffers.',
  stations: [
    station('supply-1', 'supply', 2, 2, 3),
    station('press-1', 'process', 12, 2, 3),
    station('assembly-1', 'assembly', 3, 8, 7),
    station('dispatch-1', 'delivery', 12, 8, 7),
  ],
  obstacles: Array.from({ length: 12 }, (_, y) => y)
    .filter((y) => y !== 5 && y !== 6)
    .map((y) => ({ x: 7, y })),
  robots: [
    { id: 'R1', position: { x: 1, y: 10 } },
    { id: 'R2', position: { x: 4, y: 10 } },
    { id: 'R3', position: { x: 11, y: 10 } },
    { id: 'R4', position: { x: 14, y: 10 } },
  ],
  orderStream: { count: 24, interval: 18, pattern: 'uniform', quantity: 1, item: 'product' },
};
const hotspot: Scenario = {
  ...structuredClone(base),
  id: 'hotspot',
  name: 'Hotspot dispatch',
  description: 'Two production cells and asymmetric demand at two dispatch stations.',
  stations: [
    station('supply-1', 'supply', 2, 2, 3),
    station('supply-2', 'supply', 13, 2, 3),
    station('press-1', 'process', 5, 2, 3),
    station('press-2', 'process', 10, 2, 3),
    station('assembly-1', 'assembly', 4, 8, 7),
    station('assembly-2', 'assembly', 10, 8, 7),
    station('dispatch-1', 'delivery', 1, 6, 5),
    station('dispatch-2', 'delivery', 14, 6, 5),
  ],
  robots: [
    { id: 'R1', position: { x: 2, y: 10 } },
    { id: 'R2', position: { x: 5, y: 10 } },
    { id: 'R3', position: { x: 8, y: 10 } },
    { id: 'R4', position: { x: 12, y: 10 } },
  ],
  orderStream: { count: 30, interval: 16, pattern: 'hotspot', quantity: 1, item: 'product' },
};
const heldout: Scenario = {
  ...structuredClone(base),
  id: 'heldout-offset',
  name: 'Held-out offset floor',
  description: 'A separate offset map with a central island; excluded from automatic selection.',
  width: 18,
  stations: [
    station('supply-1', 'supply', 2, 8, 7),
    station('press-1', 'process', 7, 2, 3),
    station('assembly-1', 'assembly', 14, 2, 3),
    station('dispatch-1', 'delivery', 15, 8, 7),
  ],
  obstacles: [
    { x: 8, y: 5 },
    { x: 9, y: 5 },
    { x: 8, y: 6 },
    { x: 9, y: 6 },
  ],
  seed: 991,
};
/** Fixed demand through tick 9,995+ (no warm-up); use a 600–1,200 tick observation horizon. */
export const SUSTAINED: Scenario = {
  ...structuredClone(base),
  id: 'sustained-production',
  name: 'Sustained production',
  description:
    'Twelve robots, three production cells and two dispatch stations. A seeded stream supplies 2,000 orders every five ticks; observe sustained throughput and backlog over 600–1,200 ticks, with no warm-up.',
  width: 24,
  height: 18,
  stations: [
    station('supply-1', 'supply', 2, 2, 3),
    station('supply-2', 'supply', 10, 2, 3),
    station('supply-3', 'supply', 18, 2, 3),
    station('press-1', 'process', 6, 2, 3),
    station('press-2', 'process', 14, 2, 3),
    station('press-3', 'process', 22, 2, 3),
    station('assembly-1', 'assembly', 6, 10, 9),
    station('assembly-2', 'assembly', 14, 10, 9),
    station('assembly-3', 'assembly', 22, 10, 9),
    station('dispatch-1', 'delivery', 3, 12, 11),
    station('dispatch-2', 'delivery', 19, 12, 11),
  ],
  robots: Array.from({ length: 12 }, (_, index) => ({
    id: `R${String(index + 1).padStart(2, '0')}`,
    position: { x: 1 + index * 2, y: 16 },
  })),
  orderStream: { count: 2000, interval: 5, pattern: 'uniform', quantity: 1, item: 'product' },
  seed: 512,
};
// The original finite scenarios and held-out index remain stable for historic reproduction.
export const PRESETS: Scenario[] = [base, crossing, hotspot, heldout, SUSTAINED];
