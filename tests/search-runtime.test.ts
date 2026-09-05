import { describe, expect, it } from 'vitest';
import { runSearch } from '../src/core/optimization/search';
import {
  runSimulationCooperatively,
  type EvaluationInput,
} from '../src/core/optimization/evaluation';
import { BASELINE, QUEUE_AWARE } from '../src/core/policies/config';
import { runSimulation } from '../src/core/sim/engine';
import { PRESETS } from '../src/scenarios';
import { contentHash } from '../src/core/model/random';
import {
  createSearchRuntime,
  runComparison,
  type SearchResponse,
} from '../src/workers/search-protocol';

const evaluation = (horizon = 96): EvaluationInput => ({
  scope: 'current-factory',
  scenarios: [structuredClone(PRESETS[0]!)],
  seeds: [17],
  horizon,
  codeVersion: 'runtime-test',
});
const noDelay = async (): Promise<void> => {};
const businessMetrics = <T extends { planningMs: number }>(value: T): Omit<T, 'planningMs'> => {
  const { planningMs: _ignored, ...rest } = value;
  return rest;
};

describe('cooperative shared-kernel evaluation', () => {
  it('produces the identical digest and business metrics across work chunk sizes and the CLI kernel', async () => {
    const input = evaluation();
    const direct = runSimulation(
      input.scenarios[0]!,
      BASELINE,
      17,
      input.horizon,
      input.codeVersion,
    );
    for (const chunkTicks of [1, 7, 32]) {
      const asyncRun = await runSimulationCooperatively(
        input.scenarios[0]!,
        BASELINE,
        17,
        input.horizon,
        input.codeVersion,
        { chunkTicks, yieldControl: noDelay },
      );
      expect(asyncRun.status).toBe('completed');
      expect(asyncRun.stateHash).toBe(direct.stateHash);
      expect(businessMetrics(asyncRun.metrics)).toEqual(businessMetrics(direct.metrics));
    }
  });
  it('cancels in the middle of its first long simulation and counts that started call', async () => {
    let cancelled = false;
    const result = await runSearch({
      ...evaluation(100_000),
      method: 'ga',
      budget: 6,
      optimizerSeed: 7,
      yieldControl: noDelay,
      shouldCancel: () => cancelled,
      onProgress: (p) => {
        if ((p.currentRun?.tick ?? 0) >= 32) cancelled = true;
      },
    });
    expect(result.status).toBe('cancelled');
    expect(result.counters.simulations).toBe(1);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.status).toBe('cancelled');
    expect(result.runs[0]!.metrics.ticks).toBeGreaterThanOrEqual(32);
    expect(result.runs[0]!.metrics.ticks).toBeLessThan(100_000);
    expect(result.records[0]?.status).toBe('cancelled');
    expect(result.records[0]?.score).toBeNull();
    expect(result.best).toBeNull();
  });
  it('cancels comparison during a candidate run, keeping started counts without a partial score pair', async () => {
    let cancelled = false;
    const result = await runComparison(evaluation(90), QUEUE_AWARE, {
      yieldControl: noDelay,
      shouldCancel: () => cancelled,
      onProgress: (p) => {
        if (p.phase === 'candidate' && (p.currentRun?.tick ?? 0) >= 32) cancelled = true;
      },
    });
    expect(result.status).toBe('cancelled');
    expect(result.simulations).toBe(2);
    expect(result.baseline[0]?.status).toBe('completed');
    expect(result.candidate[0]?.status).toBe('cancelled');
    expect(result.candidate[0]!.metrics.ticks).toBeLessThan(90);
    expect(result.baselineScore).toBeNull();
    expect(result.candidateScore).toBeNull();
  });
  it('compares all explicit benchmark maps and seeds from the same frozen initial conditions', async () => {
    const input: EvaluationInput = {
      ...evaluation(40),
      scope: 'benchmark-set',
      scenarios: PRESETS.slice(0, 2),
      seeds: [11, 29],
    };
    const result = await runComparison(input, BASELINE, { yieldControl: noDelay });
    expect(result.status).toBe('completed');
    expect(result.simulations).toBe(8);
    expect(result.evaluation.evaluationsPerCandidate).toBe(4);
    expect(result.baselineScore).toEqual(result.candidateScore);
    expect(result.baseline.map((r) => r.stateHash)).toEqual(
      result.candidate.map((r) => r.stateHash),
    );
    expect(result.baseline.map((r) => [r.scenarioHash, r.seed, r.horizon])).toEqual(
      result.candidate.map((r) => [r.scenarioHash, r.seed, r.horizon]),
    );
  });
});

describe('request and revision isolation', () => {
  it('discards every late search response after replacement and ignores a stale cancel', async () => {
    const messages: SearchResponse[] = [];
    const queued: (() => void)[] = [];
    const runtime = createSearchRuntime((m) => messages.push(m), {
      yieldControl: () => new Promise<void>((resolve) => queued.push(resolve)),
      progressIntervalMs: 0,
    });
    let oldDone = false,
      newDone = false;
    const old = runtime
      .handle({
        type: 'search',
        requestId: 'old',
        revision: 1,
        evaluation: evaluation(1000),
        method: 'ga',
        budget: 4,
        optimizerSeed: 7,
      })
      .then(() => {
        oldDone = true;
      });
    // The first request is paused at an actual cooperative yield, then replaced by a new scene revision.
    const edited = evaluation(8);
    edited.scenarios[0]!.id = 'edited-current-factory';
    edited.scenarios[0]!.obstacles.push({ x: 0, y: 0 });
    const newer = runtime
      .handle({
        type: 'search',
        requestId: 'new',
        revision: 2,
        evaluation: edited,
        method: 'random',
        budget: 1,
        optimizerSeed: 7,
      })
      .then(() => {
        newDone = true;
      });
    await runtime.handle({ type: 'cancel', requestId: 'old', revision: 1 });
    for (let i = 0; i < 100 && (!oldDone || !newDone); i++) {
      queued.splice(0).forEach((resolve) => resolve());
      await Promise.resolve();
    }
    await Promise.all([old, newer]);
    expect(messages.length).toBeGreaterThan(0);
    const activeMessages = messages.filter((m) => m.type !== 'retired-result');
    expect(activeMessages.every((m) => m.requestId === 'new' && m.revision === 2)).toBe(true);
    const retired = messages.filter((m) => m.type === 'retired-result');
    expect(retired).toHaveLength(1);
    expect(retired[0]?.requestId).toBe('old');
    expect(retired[0]?.type === 'retired-result' && retired[0].result.status).toBe('cancelled');
    const result = messages.find((m) => m.type === 'result');
    expect(result?.type === 'result' && result.result.status).toBe('completed');
    if (result?.type !== 'result') throw new Error('Missing result');
    expect(result.result.evaluation.scenarios).toEqual(edited.scenarios);
    expect(result.result.runs[0]?.scenarioHash).toBe(contentHash(edited.scenarios[0]!));
  });
  it('accepts a matching cancel while a real comparison invocation is executing', async () => {
    const messages: SearchResponse[] = [];
    let runtime: ReturnType<typeof createSearchRuntime>;
    runtime = createSearchRuntime(
      (m) => {
        messages.push(m);
        if (m.type === 'comparison-progress' && (m.progress.currentRun?.tick ?? 0) > 0)
          void runtime.handle({ type: 'cancel', requestId: 'compare', revision: 4 });
      },
      { yieldControl: noDelay, progressIntervalMs: 0 },
    );
    await runtime.handle({
      type: 'compare',
      requestId: 'compare',
      revision: 4,
      evaluation: evaluation(100_000),
      candidate: QUEUE_AWARE,
    });
    const response = messages.at(-1);
    expect(response?.type).toBe('comparison');
    if (response?.type !== 'comparison') throw new Error('Missing comparison response');
    expect(response.comparison.status).toBe('cancelled');
    expect(response.comparison.simulations).toBe(1);
    expect(response.comparison.baseline[0]?.status).toBe('cancelled');
  });
  it.each(['search', 'compare'] as const)(
    'archives started work from a replaced %s without letting it overwrite the current result',
    async (kind) => {
      const messages: SearchResponse[] = [];
      let replacement: Promise<void> | undefined;
      let runtime: ReturnType<typeof createSearchRuntime>;
      runtime = createSearchRuntime(
        (message) => {
          messages.push(message);
          const progressTick =
            message.type === 'progress' || message.type === 'comparison-progress'
              ? (message.progress.currentRun?.tick ?? 0)
              : 0;
          if (message.requestId === 'retiring' && progressTick > 0 && !replacement) {
            replacement = runtime.handle({
              type: 'search',
              requestId: 'replacement',
              revision: 11,
              evaluation: evaluation(8),
              method: 'random',
              budget: 1,
              optimizerSeed: 7,
            });
          }
        },
        { yieldControl: noDelay, progressIntervalMs: 0 },
      );
      await runtime.handle(
        kind === 'search'
          ? {
              type: 'search',
              requestId: 'retiring',
              revision: 10,
              evaluation: evaluation(100_000),
              method: 'ga',
              budget: 20,
              optimizerSeed: 7,
            }
          : {
              type: 'compare',
              requestId: 'retiring',
              revision: 10,
              evaluation: evaluation(100_000),
              candidate: QUEUE_AWARE,
            },
      );
      await replacement;
      const retired = messages.find(
        (m) => m.type === 'retired-result' || m.type === 'retired-comparison',
      );
      expect(retired?.requestId).toBe('retiring');
      expect(retired?.revision).toBe(10);
      if (retired?.type === 'retired-result') {
        expect(retired.result.status).toBe('cancelled');
        expect(retired.result.counters.simulations).toBe(1);
        expect(retired.result.runs[0]?.status).toBe('cancelled');
        expect(retired.result.runs[0]!.metrics.ticks).toBeGreaterThan(0);
        expect(retired.result.best).toBeNull();
      } else if (retired?.type === 'retired-comparison') {
        expect(retired.comparison.status).toBe('cancelled');
        expect(retired.comparison.simulations).toBe(1);
        expect(retired.comparison.baseline[0]?.status).toBe('cancelled');
        expect(retired.comparison.baseline[0]!.metrics.ticks).toBeGreaterThan(0);
        expect(retired.comparison.baselineScore).toBeNull();
        expect(retired.comparison.candidateScore).toBeNull();
      } else throw new Error('Missing retired accounting result');
      const activeResults = messages.filter((m) => m.type === 'result');
      expect(activeResults).toHaveLength(1);
      expect(activeResults[0]?.requestId).toBe('replacement');
      expect(activeResults[0]?.type === 'result' && activeResults[0].result.status).toBe(
        'completed',
      );
    },
  );
});
