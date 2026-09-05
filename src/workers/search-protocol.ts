import type { PolicyConfig, RunResult } from '../core/model/types';
import { normalizeConfig, BASELINE } from '../core/policies/config';
import {
  aggregate,
  runSearch,
  type Score,
  type SearchMethod,
  type SearchProgress,
  type SearchResult,
} from '../core/optimization/search';
import {
  freezeEvaluation,
  runSimulationCooperatively,
  type CooperativeOptions,
  type EvaluationInput,
  type FrozenEvaluation,
  type RunTickProgress,
} from '../core/optimization/evaluation';

export interface RequestIdentity {
  requestId: string;
  revision: number;
}
export type SearchCommand = RequestIdentity &
  (
    | {
        type: 'search';
        method: SearchMethod;
        budget: number;
        optimizerSeed: number;
        populationSize?: number;
        evaluation: EvaluationInput;
      }
    | {
        type: 'compare';
        candidate: PolicyConfig;
        baseline?: PolicyConfig;
        evaluation: EvaluationInput;
      }
    | { type: 'cancel' }
  );
export interface ComparisonProgress {
  simulations: number;
  total: number;
  phase: 'baseline' | 'candidate';
  currentRun: RunTickProgress | null;
}
export interface ComparisonResult {
  status: 'completed' | 'cancelled' | 'failed';
  evaluation: FrozenEvaluation;
  baseline: RunResult[];
  candidate: RunResult[];
  baselineScore: Score | null;
  candidateScore: Score | null;
  simulations: number;
  runtimeMs: number;
  error?: string;
}
export type SearchResponse = RequestIdentity &
  (
    | { type: 'progress'; progress: SearchProgress }
    | { type: 'comparison-progress'; progress: ComparisonProgress }
    | { type: 'result'; result: SearchResult }
    | { type: 'comparison'; comparison: ComparisonResult }
    | { type: 'retired-result'; result: SearchResult }
    | { type: 'retired-comparison'; comparison: ComparisonResult }
    | { type: 'error'; error: string }
  );

/** Both policies use the same frozen maps, order seeds and horizon, including cancellation. */
export async function runComparison(
  evaluationInput: EvaluationInput,
  candidateInput: PolicyConfig,
  options: CooperativeOptions & {
    baseline?: PolicyConfig;
    onProgress?: (progress: ComparisonProgress) => void;
  } = {},
): Promise<ComparisonResult> {
  const evaluation = freezeEvaluation(evaluationInput);
  const configs = {
    baseline: normalizeConfig(options.baseline ?? BASELINE),
    candidate: normalizeConfig(candidateInput),
  };
  const startedAt = performance.now();
  const result: ComparisonResult = {
    status: 'completed',
    evaluation,
    baseline: [],
    candidate: [],
    baselineScore: null,
    candidateScore: null,
    simulations: 0,
    runtimeMs: 0,
  };
  const yieldControl = options.yieldControl ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
  outer: for (const phase of ['baseline', 'candidate'] as const) {
    for (const scenario of evaluation.scenarios)
      for (const seed of evaluation.seeds) {
        await yieldControl();
        if (options.shouldCancel?.()) {
          result.status = 'cancelled';
          break outer;
        }
        result.simulations++;
        const emit = (currentRun: RunTickProgress | null): void =>
          options.onProgress?.({
            simulations: result.simulations,
            total: 2 * evaluation.evaluationsPerCandidate,
            phase,
            currentRun,
          });
        emit({ scenarioId: scenario.id, seed, tick: 0, horizon: evaluation.horizon });
        try {
          const run = await runSimulationCooperatively(
            scenario,
            configs[phase],
            seed,
            evaluation.horizon,
            evaluation.codeVersion,
            { ...options, yieldControl, onTickProgress: emit },
          );
          result[phase].push(run);
          if (run.status !== 'completed') {
            result.status = run.status;
            if (run.error) result.error = run.error;
            break outer;
          }
        } catch (error) {
          result.status = 'failed';
          result.error = error instanceof Error ? error.message : String(error);
          break outer;
        }
      }
    result[`${phase}Score`] = aggregate(result[phase], evaluation.horizon);
  }
  // Partial comparisons retain raw evidence but never present a comparable score pair.
  if (result.status !== 'completed') {
    result.baselineScore = null;
    result.candidateScore = null;
  }
  result.runtimeMs = performance.now() - startedAt;
  return result;
}

/** Testable worker control loop. A replacement invalidates every late message from its predecessor. */
export function createSearchRuntime(
  postMessage: (response: SearchResponse) => void,
  options: { yieldControl?: () => Promise<void>; progressIntervalMs?: number } = {},
): { handle: (message: SearchCommand) => Promise<void> } {
  let generation = 0;
  let active: (RequestIdentity & { generation: number; cancelled: boolean }) | null = null;
  const progressIntervalMs = options.progressIntervalMs ?? 75;
  return {
    async handle(message): Promise<void> {
      if (message.type === 'cancel') {
        if (active?.requestId === message.requestId && active.revision === message.revision)
          active.cancelled = true;
        return;
      }
      if (active) active.cancelled = true;
      const request = {
        requestId: message.requestId,
        revision: message.revision,
        generation: ++generation,
        cancelled: false,
      };
      active = request;
      const current = (): boolean => active === request && generation === request.generation;
      const shouldCancel = (): boolean => request.cancelled || !current();
      let lastProgressAt = -Infinity;
      const post = (response: SearchResponse): void => {
        if (current()) postMessage(response);
      };
      const identity: RequestIdentity = {
        requestId: request.requestId,
        revision: request.revision,
      };
      try {
        if (message.type === 'search') {
          const result = await runSearch({
            ...message.evaluation,
            method: message.method,
            budget: message.budget,
            optimizerSeed: message.optimizerSeed,
            populationSize: message.populationSize ?? 3,
            shouldCancel,
            yieldControl: options.yieldControl,
            onProgress(progress) {
              const now = performance.now();
              if (now - lastProgressAt >= progressIntervalMs) {
                lastProgressAt = now;
                post({ ...identity, type: 'progress', progress });
              }
            },
          });
          // Superseded jobs are accounting evidence, never active UI state. Consumers
          // archive this explicit message separately with its original scene identity.
          if (current()) post({ ...identity, type: 'result', result });
          else postMessage({ ...identity, type: 'retired-result', result });
        } else {
          const comparison = await runComparison(message.evaluation, message.candidate, {
            baseline: message.baseline,
            shouldCancel,
            yieldControl: options.yieldControl,
            onProgress(progress) {
              const now = performance.now();
              if (now - lastProgressAt >= progressIntervalMs) {
                lastProgressAt = now;
                post({ ...identity, type: 'comparison-progress', progress });
              }
            },
          });
          if (current()) post({ ...identity, type: 'comparison', comparison });
          else postMessage({ ...identity, type: 'retired-comparison', comparison });
        }
      } catch (error) {
        post({
          ...identity,
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (current()) active = null;
      }
    },
  };
}
