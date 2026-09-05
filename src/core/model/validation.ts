import type { Scenario, PolicyConfig, Point, Inventory } from './types';
import { pointKey, distance } from './types';
import { BASELINE, normalizeConfig } from '../policies/config';
export function validateScenario(value: unknown): Scenario {
  const s = structuredClone(value) as Scenario;
  const fail = (m: string): never => {
    throw new Error(`Invalid scenario: ${m}`);
  };
  if (!s || typeof s !== 'object' || s.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (
    typeof s.id !== 'string' ||
    !s.id ||
    typeof s.name !== 'string' ||
    typeof s.description !== 'string'
  )
    fail('id, name, description required');
  for (const k of ['width', 'height'] as const)
    if (!Number.isInteger(s[k]) || s[k] < 5 || s[k] > 40) fail(`${k} must be 5–40`);
  if (!Number.isInteger(s.seed) || s.seed < 0 || s.seed > 4294967295) fail('seed must be uint32');
  const point = (p: Point) => {
    if (
      !p ||
      !Number.isInteger(p.x) ||
      !Number.isInteger(p.y) ||
      p.x < 0 ||
      p.y < 0 ||
      p.x >= s.width ||
      p.y >= s.height
    )
      fail('point outside grid');
  };
  const validItem = (v: unknown) =>
    typeof v === 'string' &&
    /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(v) &&
    !Object.hasOwn(Object.prototype, v);
  const positive = (n: number) => Number.isInteger(n) && n > 0 && n <= 10000;
  const inventory = (i: Inventory) => {
    if (
      !i ||
      typeof i !== 'object' ||
      Array.isArray(i) ||
      !Object.keys(i).length ||
      Object.entries(i).some(([k, v]) => !validItem(k) || !positive(v))
    )
      fail('recipe quantities must be positive integers');
  };
  for (const key of ['obstacles', 'stations', 'robots', 'recipes', 'orders'] as const)
    if (!Array.isArray(s[key])) fail(`${key} must be an array`);
  if (
    s.robots.length > 24 ||
    s.stations.length > 64 ||
    s.orders.length > 2000 ||
    s.recipes.length > 32
  )
    fail('size limit exceeded');
  const unique = (xs: { id: string }[], label: string) => {
    const ids = new Set<string>();
    for (const x of xs) {
      if (!x || typeof x.id !== 'string' || !x.id || ids.has(x.id))
        fail(`duplicate/missing ${label} id`);
      ids.add(x.id);
    }
  };
  unique(s.robots, 'robot');
  unique(s.stations, 'station');
  unique(s.recipes, 'recipe');
  unique(s.orders, 'order');
  const occupied = new Set<string>();
  for (const p of s.obstacles) {
    point(p);
    if (occupied.has(pointKey(p))) fail('duplicate obstacle');
    occupied.add(pointKey(p));
  }
  for (const r of s.recipes) {
    inventory(r.inputs);
    if (
      !r.output ||
      !validItem(r.output.item) ||
      !positive(r.output.quantity) ||
      !positive(r.duration)
    )
      fail('invalid recipe output/duration');
  }
  const graph = new Map<string, string[]>();
  for (const r of s.recipes) {
    graph.set(r.output.item, [...(graph.get(r.output.item) ?? []), ...Object.keys(r.inputs)]);
  }
  const done = new Set<string>();
  const visit = (item: string, stack: Set<string>) => {
    if (done.has(item)) return;
    if (stack.has(item)) fail('cyclic recipe dependency');
    const next = new Set(stack).add(item);
    for (const input of graph.get(item) ?? []) visit(input, next);
    done.add(item);
  };
  for (const item of graph.keys()) visit(item, new Set());
  for (const st of s.stations) {
    point(st.position);
    point(st.service);
    if (distance(st.position, st.service) !== 1) fail('service cell must be adjacent');
    if (occupied.has(pointKey(st.position))) fail('overlapping station/obstacle');
    occupied.add(pointKey(st.position));
    if (!['supply', 'process', 'assembly', 'delivery'].includes(st.role))
      fail('unknown station role');
    if (!positive(st.inputCapacity) || !positive(st.outputCapacity))
      fail('capacities must be positive');
    if (st.role === 'supply' && (!validItem(st.supplyItem) || !positive(st.supplyInterval ?? 0)))
      fail('supply item/interval required');
    if (st.role === 'process' || st.role === 'assembly') {
      const r = s.recipes.find((r) => r.id === st.recipeId);
      if (!r) fail('unknown recipe');
      else if (
        Object.values(r.inputs).reduce((a, b) => a + b, 0) > st.inputCapacity ||
        r.output.quantity > st.outputCapacity
      )
        fail('recipe exceeds station capacity');
    }
  }
  const services = new Set<string>();
  for (const st of s.stations) {
    const k = pointKey(st.service);
    if (occupied.has(k) || services.has(k)) fail('service cells must be free and unique');
    services.add(k);
  }
  const robots = new Set<string>();
  for (const r of s.robots) {
    point(r.position);
    const k = pointKey(r.position);
    if (occupied.has(k) || robots.has(k) || services.has(k))
      fail('robot start must be free, unique, outside service cells');
    robots.add(k);
  }
  for (const o of s.orders) {
    if (
      !Number.isInteger(o.arrival) ||
      o.arrival < 0 ||
      !positive(o.quantity) ||
      !validItem(o.item) ||
      !s.stations.some((st) => st.id === o.destination && st.role === 'delivery')
    )
      fail('invalid order');
  }
  if (s.orderStream) {
    const o = s.orderStream;
    if (
      !positive(o.count) ||
      o.count > 2000 ||
      !positive(o.interval) ||
      !positive(o.quantity) ||
      !validItem(o.item) ||
      !['uniform', 'hotspot'].includes(o.pattern) ||
      !s.stations.some((st) => st.role === 'delivery')
    )
      fail('invalid order stream');
    if (s.orders.some((o) => o.id.startsWith('stream-'))) fail('stream- order ids are reserved');
  }
  return s;
}
export function parseBundle(value: unknown): { scenario: Scenario; config: PolicyConfig } {
  if (!value || typeof value !== 'object')
    throw new Error('Expected scenario or {scenario,config}');
  const v = value as { scenario?: unknown; config?: unknown };
  return {
    scenario: validateScenario(v.scenario ?? value),
    config: normalizeConfig(v.config ?? BASELINE),
  };
}
