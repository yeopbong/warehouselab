import { contentHash, stableStringify } from '../model/random';
import { KERNEL_VERSION, type PolicyConfig, type RunResult, type Scenario } from '../model/types';
import { validateScenario } from '../model/validation';
import { createSimulation, step, summarizeRun } from '../sim/engine';

export type SearchScope = 'current-factory' | 'benchmark-set';
export interface SearchParameterSpace {
  assignment: PolicyConfig['assignment'][];
  priority: PolicyConfig['priority'][];
  routing: PolicyConfig['routing'][];
  congestionWeight: [number, number];
  planningWindow: [number, number];
  replanInterval: [number, number];
}
export const DEFAULT_PARAMETER_SPACE: SearchParameterSpace = {
  assignment: ['nearest', 'earliest'],
  priority: ['fixed', 'waiting'],
  routing: ['distance', 'congestion'],
  congestionWeight: [0, 5],
  planningWindow: [4, 32],
  replanInterval: [1, 8],
};
export interface EvaluationInput {
  scope: SearchScope;
  scenarios: Scenario[];
  seeds: number[];
  horizon: number;
  codeVersion: string;
  parameterSpace?: SearchParameterSpace;
}
export interface FrozenEvaluation extends EvaluationInput {
  parameterSpace: SearchParameterSpace;
  scenarioHashes: string[];
  evaluationHash: string;
  kernelVersion: string;
  evaluationsPerCandidate: number;
  /** No warm-up exclusion: every completion through horizon counts for every policy. */
  measurement: 'completed-orders-through-horizon';
}
export interface RunTickProgress {
  scenarioId: string;
  seed: number;
  tick: number;
  horizon: number;
}
export interface CooperativeOptions {
  shouldCancel?: () => boolean;
  yieldControl?: () => Promise<void>;
  onTickProgress?: (progress: RunTickProgress) => void;
  chunkTicks?: number;
  chunkMs?: number;
}

function validateParameterSpace(value: SearchParameterSpace): SearchParameterSpace {
  const space = structuredClone(value);
  for (const name of ['assignment', 'priority', 'routing'] as const) {
    const legal: readonly string[] = DEFAULT_PARAMETER_SPACE[name];
    if (
      !Array.isArray(space[name]) ||
      !space[name].length ||
      new Set(space[name]).size !== space[name].length ||
      space[name].some((v) => !legal.includes(v))
    )
      throw new Error(`Invalid parameter space: ${name}`);
  }
  for (const name of ['congestionWeight', 'planningWindow', 'replanInterval'] as const) {
    const range = space[name],
      allowed = DEFAULT_PARAMETER_SPACE[name];
    if (
      !Array.isArray(range) ||
      range.length !== 2 ||
      range.some((n) => !Number.isFinite(n)) ||
      range[0] > range[1] ||
      range[0] < allowed[0] ||
      range[1] > allowed[1] ||
      (name !== 'congestionWeight' && range.some((n) => !Number.isInteger(n)))
    )
      throw new Error(`Invalid parameter space: ${name}`);
  }
  return space;
}

/** Clone synchronously before the first yield: edits to the caller cannot change a run. */
export function freezeEvaluation(input: EvaluationInput): FrozenEvaluation {
  if (input.scope !== 'current-factory' && input.scope !== 'benchmark-set')
    throw new Error('Unknown evaluation scope');
  if (
    !Array.isArray(input.scenarios) ||
    !input.scenarios.length ||
    (input.scope === 'current-factory' && input.scenarios.length !== 1)
  )
    throw new Error(
      'Current factory requires exactly one scene; benchmark set needs explicit scenes',
    );
  if (!Number.isSafeInteger(input.horizon) || input.horizon < 1)
    throw new Error('Horizon must be a positive safe integer');
  if (
    !input.seeds.length ||
    input.seeds.some((seed) => !Number.isInteger(seed) || seed < 0 || seed > 4294967295)
  )
    throw new Error('Evaluation seeds must be uint32 integers (0–4294967295)');
  if (new Set(input.seeds).size !== input.seeds.length)
    throw new Error('Evaluation seeds must be distinct');
  if (!input.codeVersion.trim()) throw new Error('Code version is required');
  const scenarios = input.scenarios.map(validateScenario);
  // A hash is metadata; canonical content, not a short hash, keys the simulator cache.
  if (new Set(scenarios.map(stableStringify)).size !== scenarios.length)
    throw new Error('Evaluation scenarios must be distinct');
  const parameters = {
    scope: input.scope,
    scenarios,
    scenarioHashes: scenarios.map(contentHash),
    seeds: [...input.seeds],
    horizon: input.horizon,
    codeVersion: input.codeVersion,
    kernelVersion: KERNEL_VERSION,
    parameterSpace: validateParameterSpace(input.parameterSpace ?? DEFAULT_PARAMETER_SPACE),
    evaluationsPerCandidate: scenarios.length * input.seeds.length,
    measurement: 'completed-orders-through-horizon' as const,
  };
  return { ...parameters, evaluationHash: contentHash(parameters) };
}

/** One kernel, integer steps, bounded work, and cancellation only at safe tick boundaries. */
export async function runSimulationCooperatively(
  scenario: Scenario,
  config: PolicyConfig,
  seed: number,
  horizon: number,
  codeVersion = 'dev-dirty',
  options: CooperativeOptions = {},
): Promise<RunResult> {
  if (!Number.isSafeInteger(horizon) || horizon < 1)
    throw new Error('Horizon must be a positive safe integer');
  const chunkTicks = options.chunkTicks ?? 32;
  const chunkMs = options.chunkMs ?? 8;
  if (
    !Number.isSafeInteger(chunkTicks) ||
    chunkTicks < 1 ||
    !Number.isFinite(chunkMs) ||
    chunkMs <= 0
  )
    throw new Error('Invalid cooperative work limit');
  const yieldControl = options.yieldControl ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
  const startedAt = performance.now();
  const state = createSimulation(scenario, config, seed);
  let status: RunResult['status'] = 'completed';
  let error: string | undefined;
  try {
    while (state.tick < horizon) {
      if (options.shouldCancel?.()) {
        status = 'cancelled';
        break;
      }
      const chunkStart = performance.now();
      let ticks = 0;
      do {
        step(state);
        ticks++;
      } while (
        state.tick < horizon &&
        ticks < chunkTicks &&
        performance.now() - chunkStart < chunkMs
      );
      options.onTickProgress?.({ scenarioId: scenario.id, seed, tick: state.tick, horizon });
      // Let control messages run even when a single simulator invocation is very long.
      await yieldControl();
      if (options.shouldCancel?.()) {
        status = 'cancelled';
        break;
      }
    }
  } catch (e) {
    status = 'failed';
    error = e instanceof Error ? e.message : String(e);
  }
  return summarizeRun(state, horizon, codeVersion, performance.now() - startedAt, status, error);
}
