import { describe, it, expect } from 'vitest';
import { PRESETS } from '../src/scenarios';
import { BASELINE, QUEUE_AWARE, normalizeConfig } from '../src/core/policies/config';
import {
  createSimulation,
  step,
  metrics,
  runSimulation,
  stateDigest,
  assertInvariants,
  cancelTask,
} from '../src/core/sim/engine';
import { chooseRobot, estimatedFinish } from '../src/core/policies/assignment';
import { parseBundle, validateScenario } from '../src/core/model/validation';
import { samePoint, type SimState } from '../src/core/model/types';
const advance = (s: SimState, ticks: number) => {
  for (let i = 0; i < ticks; i++) step(s);
  return s;
};
describe('production, reservations and accounting', () => {
  it('completes actual two-stage orders and conserves every material', () => {
    const s = advance(createSimulation(PRESETS[0], BASELINE), 600);
    expect(metrics(s).completedOrders).toBe(20);
    expect(s.ledger.delivered.product).toBe(20);
    expect(s.ledger.consumed.part).toBeGreaterThanOrEqual(40);
    expect(s.ledger.produced.product).toBeGreaterThanOrEqual(20);
    assertInvariants(s);
  });
  it('reserves one task exactly once, releases cancellation, and rejects cargo cancellation', () => {
    const s = createSimulation(PRESETS[0], QUEUE_AWARE);
    while (!s.robots.some((r) => r.tasks.length)) step(s);
    const r = s.robots.find((r) => r.tasks.length)!,
      t = r.tasks[0],
      src = s.stations.find((st) => st.id === t.source)!;
    const before = src.reservedOutput[t.item];
    expect(cancelTask(s, t.id)).toBe(true);
    expect(src.reservedOutput[t.item]).toBe(before - 1);
    expect(cancelTask(s, t.id)).toBe(false);
    assertInvariants(s);
    while (!s.robots.some((r) => r.load)) step(s);
    const loaded = s.robots.find((r) => r.load)!;
    expect(cancelTask(s, loaded.tasks[0].id)).toBe(false);
    assertInvariants(s);
  });
  it('holds real cargo through loading and unloading without copying', () => {
    const s = createSimulation(PRESETS[0], BASELINE);
    let sawLoading = false,
      sawCargo = false,
      sawUnloading = false;
    for (let i = 0; i < 160; i++) {
      step(s);
      sawLoading ||= s.robots.some((r) => r.status === 'loading');
      sawCargo ||= s.robots.some((r) => !!r.load);
      sawUnloading ||= s.robots.some((r) => r.status === 'unloading');
      assertInvariants(s);
    }
    expect([sawLoading, sawCargo, sawUnloading]).toEqual([true, true, true]);
    expect(metrics(s).completedOrders).toBeGreaterThan(0);
  });
  it('retains completed processing in finite output buffers when robots cannot empty them', () => {
    const sc = structuredClone(PRESETS[0]);
    sc.robots = [];
    const s = createSimulation(sc, BASELINE);
    const st = s.stations.find((x) => x.role === 'process')!;
    st.input = { raw: 3 };
    st.output = { part: 3 };
    s.ledger.supplied.raw = 3;
    s.ledger.produced.part = 3;
    advance(s, 20);
    expect(st.processing?.remaining).toBe(0);
    expect(st.status).toBe('Output blocked');
    expect(st.output.part).toBe(3);
    assertInvariants(s);
  });
  it('never completes an order on reservation, input delivery, or unfinished assembly', () => {
    const s = createSimulation(PRESETS[0], BASELINE);
    for (let i = 0; i < 35; i++) step(s);
    expect(metrics(s).completedOrders).toBe(0);
    expect(s.ledger.delivered.product ?? 0).toBe(0);
    expect(s.orders.every((o) => o.completedAt === null)).toBe(true);
  });
  it('flags real stagnation but excludes future arrivals and normal processing', () => {
    const sc = structuredClone(PRESETS[0]);
    sc.orderStream = undefined;
    sc.orders = [
      { id: 'future', arrival: 200, item: 'product', quantity: 1, destination: 'dispatch-1' },
    ];
    sc.robots = [];
    const s = advance(createSimulation(sc, BASELINE), 150);
    expect(s.warning).toBeNull();
    expect(metrics(s).oldestUnfinishedAge).toBeNull();
    advance(s, 180);
    expect(s.warning).toContain('No material progress');
    expect(s.orders[0].remaining).toBe(1);
    expect(metrics(s).oldestUnfinishedAge).toBe(130);
  });
  it('parks idle robots outside service cells after fulfilling demand', () => {
    const sc = structuredClone(PRESETS[0]);
    sc.orderStream = undefined;
    sc.orders = [
      { id: 'one', arrival: 0, item: 'product', quantity: 1, destination: 'dispatch-1' },
    ];
    const s = advance(createSimulation(sc, BASELINE), 400);
    expect(metrics(s).completedOrders).toBe(1);
    expect(s.robots.every((r) => !s.stations.some((st) => samePoint(st.service, r.position)))).toBe(
      true,
    );
  });
});
describe('determinism, import and policy behavior', () => {
  it('replays identical states and deterministic metrics without wall-clock dependence', () => {
    const a = advance(createSimulation(PRESETS[1], QUEUE_AWARE, 91), 220),
      b = advance(createSimulation(PRESETS[1], QUEUE_AWARE, 91), 220);
    expect(stateDigest(a)).toBe(stateDigest(b));
    const ma = metrics(a),
      mb = metrics(b);
    expect({ ...ma, planningMs: 0 }).toEqual({ ...mb, planningMs: 0 });
  });
  it('JSON roundtrip preserves scenario, configuration, order stream and output', () => {
    const bundle = parseBundle(
      JSON.parse(JSON.stringify({ scenario: PRESETS[0], config: QUEUE_AWARE })),
    );
    expect(bundle.scenario).toEqual(PRESETS[0]);
    expect(runSimulation(bundle.scenario, bundle.config, 11, 150).stateHash).toBe(
      runSimulation(PRESETS[0], QUEUE_AWARE, 11, 150).stateHash,
    );
  });
  it('precomputes identical demand independent of policy and optimizer execution', () => {
    expect(createSimulation(PRESETS[2], BASELINE, 77).orders).toEqual(
      createSimulation(PRESETS[2], QUEUE_AWARE, 77).orders,
    );
    expect(createSimulation(PRESETS[2], BASELINE, 78).orders).not.toEqual(
      createSimulation(PRESETS[2], BASELINE, 77).orders,
    );
  });
  it('earliest finish considers remaining work and a bounded committed queue', () => {
    const s = createSimulation(PRESETS[0], QUEUE_AWARE);
    const [a, b] = s.robots;
    s.robots = [a, b];
    a.position = { x: 2, y: 4 };
    b.position = { x: 15, y: 11 };
    const task = { source: 'supply-1', destination: 'press-1' };
    a.tasks = [
      {
        id: 'test',
        ...task,
        item: 'raw',
        quantity: 1,
        assignedTo: a.id,
        createdAt: 0,
        phase: 'reserved',
      },
    ];
    expect(chooseRobot(s, task)?.id).toBe(a.id);
    s.config = BASELINE;
    expect(chooseRobot(s, task)?.id).toBe(b.id);
    s.config = QUEUE_AWARE;
    const one = estimatedFinish(s, a, task);
    a.tasks.push({ ...a.tasks[0], id: 'test2' });
    expect(estimatedFinish(s, a, task)).toBeGreaterThan(one);
    a.tasks.push({ ...a.tasks[0], id: 'test3' });
    expect(chooseRobot(s, task)?.id).toBe(b.id);
  });
  it('different assignment policies change real commitments', () => {
    const a = advance(createSimulation(PRESETS[2], BASELINE), 25),
      b = advance(createSimulation(PRESETS[2], { ...BASELINE, assignment: 'earliest' }), 25);
    expect(a.robots.map((r) => r.tasks.map((t) => t.id))).not.toEqual(
      b.robots.map((r) => r.tasks.map((t) => t.id)),
    );
    expect(a.robots.every((r) => r.tasks.length <= 1)).toBe(true);
  });
  it('validates geometry, recipes, orders and policy limits', () => {
    expect(() => normalizeConfig({ ...BASELINE, planningWindow: 3 })).toThrow();
    expect(normalizeConfig({ ...BASELINE, congestionWeight: 3 }).congestionWeight).toBe(0);
    const sc = structuredClone(PRESETS[0]);
    sc.obstacles.push(sc.stations[0].service);
    expect(() => validateScenario(sc)).toThrow();
    const cyclic = structuredClone(PRESETS[0]);
    cyclic.recipes[0].inputs = { product: 1 };
    expect(() => validateScenario(cyclic)).toThrow('cyclic');
  });
  it.each(PRESETS)(
    '$id: all windows remain safe and default delivers',
    (sc) => {
      for (const window of [4, 12, 32]) {
        const result = runSimulation(sc, { ...BASELINE, planningWindow: window }, sc.seed, 400);
        expect(result.status, result.error).toBe('completed');
        if (window === 12)
          expect(result.metrics.completedOrders, `${sc.id} default window`).toBeGreaterThan(0);
      }
    },
    30_000,
  );
});
