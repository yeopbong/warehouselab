import { describe, expect, it } from 'vitest';
import { contentHash, random } from '../src/core/model/random';
import {
  KERNEL_VERSION,
  type PolicyConfig,
  type RunResult,
  type Scenario,
} from '../src/core/model/types';
import {
  cacheKey,
  compareScores,
  crossover,
  mutate,
  runSearch,
  sampleConfig,
} from '../src/core/optimization/search';
import { BASELINE, QUEUE_AWARE, normalizeConfig } from '../src/core/policies/config';
import { runSimulation } from '../src/core/sim/engine';
import { PRESETS } from '../src/scenarios';
import { DEFAULT_PARAMETER_SPACE, freezeEvaluation } from '../src/core/optimization/evaluation';

const scenario = (id: string): Scenario => ({
  schemaVersion: 1,
  id,
  name: id,
  description: '',
  width: 5,
  height: 5,
  obstacles: [],
  stations: [],
  recipes: [],
  robots: [],
  orders: [],
  seed: 11,
});
const simulate = (
  s: Scenario,
  config: PolicyConfig,
  seed: number,
  horizon: number,
  codeVersion = 'test',
): RunResult => ({
  scenarioId: s.id,
  scenarioHash: contentHash(s),
  config,
  seed,
  horizon,
  kernelVersion: KERNEL_VERSION,
  codeVersion,
  metrics: {
    ticks: horizon,
    completedOrders: config.assignment === 'nearest' ? 2 : 3,
    unfinishedOrders: config.assignment === 'nearest' ? 3 : 2,
    deliveredUnits: 3,
    throughput: (config.assignment === 'nearest' ? 2 : 3) / horizon,
    meanDelay: 2,
    maxDelay: 3,
    oldestUnfinishedAge: 4,
    waitingRatio: 0.1,
    stationUtilization: {},
    stalledTicks: 0,
    planningMs: 1,
  },
  stateHash: contentHash({ s, config, seed, horizon }),
  runtimeMs: 1,
  planningMs: 1,
  status: 'completed',
});
const common = {
  scope: 'benchmark-set' as const,
  scenarios: [scenario('a'), scenario('b')],
  seeds: [11, 29],
  horizon: 10,
  optimizerSeed: 7,
  yieldControl: async () => {},
  simulate,
};

describe('mixed configuration operators', () => {
  it('keeps categories and integer/continuous bounds legal across many mutations and crossings', () => {
    const rng = random(31);
    let a = BASELINE;
    for (let i = 0; i < 300; i++) {
      const b = sampleConfig(rng);
      a = mutate(crossover(a, b, rng), rng, 1);
      expect(normalizeConfig(a)).toEqual(a);
      expect(Number.isInteger(a.planningWindow)).toBe(true);
      expect(Number.isInteger(a.replanInterval)).toBe(true);
      if (a.routing === 'distance') expect(a.congestionWeight).toBe(0);
    }
  });
  it('normalizes disabled weights and keys all evaluation conditions by canonical scenario content', () => {
    const s = scenario('a');
    const key = cacheKey(s, BASELINE, 11, 100, 'abc');
    expect(cacheKey(s, { ...BASELINE, congestionWeight: 4 }, 11, 100, 'abc')).toBe(key);
    expect(cacheKey({ ...s, obstacles: [{ x: 1, y: 1 }] }, BASELINE, 11, 100, 'abc')).not.toBe(key);
    expect(cacheKey(s, BASELINE, 12, 100, 'abc')).not.toBe(key);
    expect(cacheKey(s, BASELINE, 11, 101, 'abc')).not.toBe(key);
    expect(cacheKey(s, BASELINE, 11, 100, 'abc-dirty')).not.toBe(key);
    expect(key).toContain(KERNEL_VERSION);
  });
  it('ranks actual completed rate before unfinished orders then waiting', () => {
    expect(
      compareScores(
        { throughput: 0.2, unfinishedOrders: 20, waitingRatio: 1 },
        { throughput: 0.1, unfinishedOrders: 0, waitingRatio: 0 },
      ),
    ).toBeLessThan(0);
    expect(
      compareScores(
        { throughput: 0.2, unfinishedOrders: 1, waitingRatio: 1 },
        { throughput: 0.2, unfinishedOrders: 2, waitingRatio: 0 },
      ),
    ).toBeLessThan(0);
    expect(
      compareScores(
        { throughput: 0.2, unfinishedOrders: 1, waitingRatio: 0 },
        { throughput: 0.2, unfinishedOrders: 1, waitingRatio: 1 },
      ),
    ).toBeLessThan(0);
  });
});

describe('actual simulation budgets, cancellation and failures', () => {
  it('counts each scenario/seed call and never ranks incomplete evaluation sets', async () => {
    const r = await runSearch({ ...common, method: 'random', budget: 7 });
    expect(r.counters).toEqual({ proposals: 2, cacheHits: 0, simulations: 7 });
    expect(r.status).toBe('budget-exhausted');
    expect(r.runs).toHaveLength(7);
    expect(r.records[0]?.status).toBe('completed');
    expect(r.records[1]?.status).toBe('incomplete');
    expect(r.records[1]?.score).toBeNull();
    expect(r.best?.config).toEqual(BASELINE);
    expect(r.history.map((h) => h.simulations)).toEqual([4]);
  });
  it('gives both methods the identical counted human starting candidates and conditions', async () => {
    const runs = await Promise.all(
      ['random', 'ga'].map((method) =>
        runSearch({ ...common, method: method as 'random' | 'ga', budget: 8 }),
      ),
    );
    for (const r of runs) {
      expect(r.counters.simulations).toBe(8);
      expect(r.records.map((c) => c.config)).toEqual([BASELINE, QUEUE_AWARE]);
      expect(r.best?.config).toEqual(QUEUE_AWARE);
      expect(r.status).toBe('completed');
    }
    expect(runs[0]?.runs).toEqual(runs[1]?.runs);
  });
  it('cancels after a real invocation and preserves partial work without selecting it', async () => {
    let cancelled = false;
    const r = await runSearch({
      ...common,
      method: 'ga',
      budget: 12,
      shouldCancel: () => cancelled,
      onProgress: (progress) => {
        if (progress.counters.simulations === 1) cancelled = true;
      },
    });
    expect(r.status).toBe('cancelled');
    expect(r.counters.simulations).toBe(1);
    expect(r.runs).toHaveLength(1);
    expect(r.records[0]?.status).toBe('cancelled');
    expect(r.best).toBeNull();
  });
  it('checks cancellation before its first invocation', async () => {
    const r = await runSearch({ ...common, method: 'random', budget: 8, shouldCancel: () => true });
    expect(r.status).toBe('cancelled');
    expect(r.counters.simulations).toBe(0);
    expect(r.records).toEqual([]);
  });
  it('stops on a failed invariant result, retains it, and never assigns a penalty score', async () => {
    const r = await runSearch({
      ...common,
      method: 'ga',
      budget: 20,
      simulate: (...args) => ({
        ...simulate(...args),
        status: 'failed',
        error: 'Inventory conservation failed',
      }),
    });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/Inventory conservation/);
    expect(r.counters.simulations).toBe(1);
    expect(r.runs[0]?.status).toBe('failed');
    expect(r.records[0]?.score).toBeNull();
    expect(r.best).toBeNull();
  });
  it('records thrown implementation errors as failed attempts and stops immediately', async () => {
    const r = await runSearch({
      ...common,
      method: 'random',
      budget: 20,
      simulate: () => {
        throw new Error('Collision invariant failed');
      },
    });
    expect(r.status).toBe('failed');
    expect(r.counters.simulations).toBe(1);
    expect(r.records[0]?.error).toMatch(/Collision invariant/);
    expect(r.records[0]?.score).toBeNull();
  });
  it('reports a proposal cap without claiming unused simulation budget was spent', async () => {
    const r = await runSearch({ ...common, method: 'ga', budget: 40, maxProposals: 2 });
    expect(r.status).toBe('proposal-limit');
    expect(r.counters.simulations).toBe(8);
    expect(r.counters.proposals).toBe(2);
  });
  it('rejects invalid budgets and duplicate evaluation seeds', async () => {
    await expect(runSearch({ ...common, method: 'ga', budget: -1 })).rejects.toThrow('Budget');
    await expect(runSearch({ ...common, method: 'ga', budget: 8, seeds: [1, 1] })).rejects.toThrow(
      'distinct',
    );
  });
  it.each([Number.NaN, -1, 4294967296, 1.5])(
    'rejects invalid evaluation and optimizer seeds: %s',
    async (seed) => {
      await expect(
        runSearch({ ...common, method: 'ga', budget: 8, seeds: [seed] }),
      ).rejects.toThrow('uint32');
      await expect(
        runSearch({ ...common, method: 'ga', budget: 8, optimizerSeed: seed }),
      ).rejects.toThrow('uint32');
    },
  );
  it('counts cache hits separately from invocations during genetic reproduction', async () => {
    const r = await runSearch({
      ...common,
      scenarios: [scenario('a')],
      seeds: [11],
      method: 'ga',
      populationSize: 2,
      budget: 20,
      maxProposals: 200,
    });
    expect(r.status).toBe('completed');
    expect(r.counters.simulations).toBe(20);
    expect(r.counters.cacheHits).toBeGreaterThan(0);
    expect(r.counters.proposals).toBe(r.counters.simulations + r.counters.cacheHits);
    expect(r.runs).toHaveLength(20);
    expect(r.history.at(-1)?.simulations).toBe(20);
  });
});

it('exports a best config that replays through the real shared kernel to the same state', async () => {
  const r = await runSearch({
    method: 'random',
    scenarios: [PRESETS[0]!],
    seeds: [11],
    horizon: 80,
    budget: 2,
    optimizerSeed: 17,
    codeVersion: 'test-fixed',
    yieldControl: async () => {},
  });
  expect(r.status).toBe('completed');
  const exported = JSON.parse(JSON.stringify(r.best!.config)) as unknown;
  const replay = runSimulation(PRESETS[0]!, normalizeConfig(exported), 11, 80, 'test-fixed');
  expect(replay.status).toBe('completed');
  expect(replay.stateHash).toBe(r.best!.runs[0]!.stateHash);
  const { planningMs: ignoredReplay, ...replayMetrics } = replay.metrics;
  const { planningMs: ignoredSearch, ...searchMetrics } = r.best!.runs[0]!.metrics;
  void ignoredReplay;
  void ignoredSearch;
  expect(replayMetrics).toEqual(searchMetrics);
});

describe('frozen evaluation scope', () => {
  it('evaluates the edited current factory and freezes actual content, seeds, space and version', async () => {
    const edited = scenario('my-factory');
    edited.obstacles.push({ x: 2, y: 2 });
    const original = structuredClone(edited);
    const seeds = [17];
    let changed = false;
    const calls: Scenario[] = [];
    const r = await runSearch({
      method: 'random',
      scenarios: [edited],
      seeds,
      horizon: 8,
      budget: 2,
      optimizerSeed: 7,
      codeVersion: 'scope-revision',
      simulate: (...args) => {
        calls.push(structuredClone(args[0]));
        return simulate(...args);
      },
      yieldControl: async () => {
        if (!changed) {
          edited.obstacles.push({ x: 1, y: 1 });
          seeds[0] = 99;
          changed = true;
        }
      },
    });
    expect(r.scope).toBe('current-factory');
    expect(r.evaluationsPerCandidate).toBe(1);
    expect(r.evaluation.scenarios).toEqual([original]);
    expect(r.evaluation.scenarioHashes).toEqual([contentHash(original)]);
    expect(r.evaluation.seeds).toEqual([17]);
    expect(r.evaluation.codeVersion).toBe('scope-revision');
    expect(r.evaluation.parameterSpace).toEqual(DEFAULT_PARAMETER_SPACE);
    expect(calls).toEqual([original, original]);
    expect(r.runs.every((run) => run.scenarioHash === contentHash(original))).toBe(true);
    expect(r.evaluation.evaluationHash).toBe(
      freezeEvaluation({
        scope: 'current-factory',
        scenarios: [original],
        seeds: [17],
        horizon: 8,
        codeVersion: 'scope-revision',
      }).evaluationHash,
    );
  });
  it('requires explicit multi-map benchmark scope and counts map × seed cost', async () => {
    await expect(
      runSearch({ ...common, scope: 'current-factory', method: 'ga', budget: 8 }),
    ).rejects.toThrow('exactly one scene');
    const r = await runSearch({ ...common, method: 'ga', budget: 8 });
    expect(r.scope).toBe('benchmark-set');
    expect(r.evaluationsPerCandidate).toBe(4);
    expect(r.evaluation.scenarios.map((s) => s.id)).toEqual(['a', 'b']);
    expect(r.counters.simulations).toBe(2 * r.evaluationsPerCandidate);
  });
  it('actually samples the frozen parameter space and emits compact, detached progress', async () => {
    const space = {
      ...structuredClone(DEFAULT_PARAMETER_SPACE),
      routing: ['congestion'] as const,
      congestionWeight: [1.2, 1.6] as [number, number],
      planningWindow: [5, 7] as [number, number],
      replanInterval: [2, 3] as [number, number],
    };
    const progressSizes: number[] = [];
    const r = await runSearch({
      ...common,
      scenarios: [scenario('current')],
      seeds: [11],
      method: 'ga',
      budget: 20,
      parameterSpace: { ...space, routing: [...space.routing] },
      onProgress: (p) => {
        expect(p).not.toHaveProperty('history');
        expect(p).not.toHaveProperty('runs');
        if (p.best) expect(p.best).not.toHaveProperty('runs');
        progressSizes.push(JSON.stringify(p).length);
        if (p.best) p.best.config.planningWindow = 32;
      },
    });
    expect(r.evaluation.parameterSpace.planningWindow).toEqual([5, 7]);
    for (const record of r.records) {
      expect(record.config.routing).toBe('congestion');
      expect(record.config.congestionWeight).toBeGreaterThanOrEqual(1.2);
      expect(record.config.congestionWeight).toBeLessThanOrEqual(1.6);
      expect(record.config.planningWindow).toBeGreaterThanOrEqual(5);
      expect(record.config.planningWindow).toBeLessThanOrEqual(7);
      expect(record.config.replanInterval).toBeGreaterThanOrEqual(2);
      expect(record.config.replanInterval).toBeLessThanOrEqual(3);
    }
    expect(Math.max(...progressSizes)).toBeLessThan(1500);
    expect(r.history.length).toBeGreaterThan(2);
  });
});
