import { contentHash, random, stableStringify } from '../model/random';
import { KERNEL_VERSION, type PolicyConfig, type RunResult, type Scenario } from '../model/types';
import { BASELINE, QUEUE_AWARE, normalizeConfig } from '../policies/config';
import { runSimulation } from '../sim/engine';
import {
  freezeEvaluation,
  runSimulationCooperatively,
  DEFAULT_PARAMETER_SPACE,
  type FrozenEvaluation,
  type RunTickProgress,
  type SearchScope,
  type SearchParameterSpace,
} from './evaluation';

export type SearchMethod = 'random' | 'ga';
/** FIFO within one search; every eviction/re-evaluation remains an actual budgeted call. */
export const SEARCH_CACHE_CAPACITY = 2048;
export interface Score {
  throughput: number;
  unfinishedOrders: number;
  waitingRatio: number;
}
export interface CandidateEvaluation {
  id: number;
  config: PolicyConfig;
  status: 'completed' | 'incomplete' | 'cancelled' | 'failed';
  score: Score | null;
  runs: RunResult[];
  simulationsAtCompletion: number;
  error?: string;
}
export interface SearchCounters {
  proposals: number;
  cacheHits: number;
  simulations: number;
}
export interface HistoryEntry {
  simulations: number;
  proposals: number;
  bestScore: Score;
  bestConfig: PolicyConfig;
}
export interface SearchProgress {
  counters: SearchCounters;
  budget: number;
  best: Pick<CandidateEvaluation, 'id' | 'config' | 'score'> | null;
  scope: SearchScope;
  scenarioHashes: string[];
  evaluationHash: string;
  evaluationsPerCandidate: number;
  currentRun: RunTickProgress | null;
}
export interface SearchResult extends SearchProgress {
  best: CandidateEvaluation | null;
  history: HistoryEntry[];
  evaluation: FrozenEvaluation;
  method: SearchMethod;
  status: 'completed' | 'cancelled' | 'failed' | 'proposal-limit' | 'budget-exhausted';
  optimizerSeed: number;
  horizon: number;
  seeds: number[];
  kernelVersion: string;
  codeVersion: string;
  records: CandidateEvaluation[];
  /** Actual simulator invocations only. Cached runs remain in candidate records. */
  runs: RunResult[];
  runtimeMs: number;
  cacheCapacity: number;
  error?: string;
}
export interface SearchOptions {
  method: SearchMethod;
  scenarios: Scenario[];
  seeds: number[];
  horizon: number;
  budget: number;
  optimizerSeed: number;
  codeVersion?: string;
  scope?: SearchScope;
  parameterSpace?: SearchParameterSpace;
  maxProposals?: number;
  populationSize?: number;
  shouldCancel?: () => boolean;
  yieldControl?: () => Promise<void>;
  onProgress?: (progress: SearchProgress) => void;
  /** Dependency injection supports small, meaningful budget/error tests. */
  simulate?: typeof runSimulation;
}

export function cacheKey(
  scenario: Scenario,
  config: PolicyConfig,
  seed: number,
  horizon: number,
  codeVersion: string,
): string {
  // Keep canonical content in the key as well as exported hashes: short hash collisions
  // must never turn a different map or order stream into a cached evaluation.
  return stableStringify({
    scenario,
    config: normalizeConfig(config),
    seed,
    horizon,
    kernelVersion: KERNEL_VERSION,
    codeVersion,
  });
}

/** Negative means a is preferable. No collision or inventory penalties are used. */
export function compareScores(a: Score, b: Score): number {
  return (
    b.throughput - a.throughput ||
    a.unfinishedOrders - b.unfinishedOrders ||
    a.waitingRatio - b.waitingRatio
  );
}
function compareCandidates(a: CandidateEvaluation, b: CandidateEvaluation): number {
  if (!a.score || !b.score) throw new Error('Only complete evaluations may be ranked');
  return (
    compareScores(a.score, b.score) ||
    stableStringify(a.config).localeCompare(stableStringify(b.config)) ||
    a.id - b.id
  );
}
const clamp = (x: number, low: number, high: number): number => Math.max(low, Math.min(high, x));
const choose = <T>(rng: () => number, a: T, b: T): T => (rng() < 0.5 ? a : b);
const integer = (rng: () => number, low: number, high: number): number =>
  low + Math.floor(rng() * (high - low + 1));

export function sampleConfig(rng: () => number): PolicyConfig {
  return normalizeConfig({
    assignment: choose(rng, 'nearest', 'earliest'),
    priority: choose(rng, 'fixed', 'waiting'),
    routing: choose(rng, 'distance', 'congestion'),
    congestionWeight: rng() * 5,
    planningWindow: integer(rng, 4, 32),
    replanInterval: integer(rng, 1, 8),
  });
}
/** Uniform categorical/integer inheritance; bounded arithmetic continuous crossover. */
export function crossover(a: PolicyConfig, b: PolicyConfig, rng: () => number): PolicyConfig {
  const alpha = rng();
  return normalizeConfig({
    assignment: choose(rng, a.assignment, b.assignment),
    priority: choose(rng, a.priority, b.priority),
    routing: choose(rng, a.routing, b.routing),
    congestionWeight: alpha * a.congestionWeight + (1 - alpha) * b.congestionWeight,
    planningWindow: choose(rng, a.planningWindow, b.planningWindow),
    replanInterval: choose(rng, a.replanInterval, b.replanInterval),
  });
}
/** Categories resample legally; integers take bounded integer steps; weight stays continuous. */
export function mutate(config: PolicyConfig, rng: () => number, rate = 0.3): PolicyConfig {
  const c = { ...config };
  if (rng() < rate) c.assignment = choose(rng, 'nearest', 'earliest');
  if (rng() < rate) c.priority = choose(rng, 'fixed', 'waiting');
  if (rng() < rate) c.routing = choose(rng, 'distance', 'congestion');
  if (rng() < rate) c.congestionWeight = clamp(c.congestionWeight + (rng() * 2 - 1) * 1.25, 0, 5);
  if (rng() < rate) c.planningWindow = clamp(c.planningWindow + integer(rng, -5, 5), 4, 32);
  if (rng() < rate) c.replanInterval = clamp(c.replanInterval + integer(rng, -2, 2), 1, 8);
  return normalizeConfig(c);
}
export function aggregate(runs: RunResult[], horizon: number): Score {
  const n = runs.length;
  return {
    throughput: runs.reduce((sum, r) => sum + r.metrics.completedOrders / horizon, 0) / n,
    unfinishedOrders: runs.reduce((sum, r) => sum + r.metrics.unfinishedOrders, 0) / n,
    waitingRatio: runs.reduce((sum, r) => sum + r.metrics.waitingRatio, 0) / n,
  };
}
function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive safe integer`);
}

/**
 * Sequential async orchestration around the shared deterministic kernel. Every actual
 * call counts, including initial human candidates and failed attempts. Cancellation
 * runs between safe tick chunks and calls; no partial set is selected.
 */
export async function runSearch(options: SearchOptions): Promise<SearchResult> {
  const { method, horizon, budget, optimizerSeed } = options;
  if (method !== 'random' && method !== 'ga') throw new Error('Unknown search method');
  assertPositiveInteger(horizon, 'Horizon');
  assertPositiveInteger(budget, 'Budget');
  const validSeed = (seed: number): boolean =>
    Number.isInteger(seed) && seed >= 0 && seed <= 4294967295;
  if (!validSeed(optimizerSeed)) throw new Error('Seeds must be uint32 integers (0–4294967295)');
  const evaluation = freezeEvaluation({
    scope: options.scope ?? 'current-factory',
    scenarios: options.scenarios,
    seeds: options.seeds,
    horizon,
    codeVersion: options.codeVersion ?? 'dev-dirty',
    parameterSpace: options.parameterSpace,
  });
  const { scenarios, seeds, codeVersion, parameterSpace } = evaluation;
  const maxProposals = options.maxProposals ?? Math.max(100, budget * 20);
  const populationSize = options.populationSize ?? 8;
  assertPositiveInteger(maxProposals, 'Proposal limit');
  assertPositiveInteger(populationSize, 'Population size');
  if (populationSize < 2) throw new Error('Population size must be at least two');
  const startedAt = performance.now();
  const rng = random(optimizerSeed);
  const yieldControl =
    options.yieldControl ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const cache = new Map<string, RunResult>();
  const result: SearchResult = {
    method,
    status: 'completed',
    optimizerSeed,
    horizon,
    seeds: [...seeds],
    codeVersion,
    kernelVersion: KERNEL_VERSION,
    counters: { proposals: 0, cacheHits: 0, simulations: 0 },
    budget,
    best: null,
    history: [],
    records: [],
    runs: [],
    runtimeMs: 0,
    cacheCapacity: SEARCH_CACHE_CAPACITY,
    evaluation,
    scope: evaluation.scope,
    scenarioHashes: evaluation.scenarioHashes,
    evaluationHash: evaluation.evaluationHash,
    evaluationsPerCandidate: evaluation.evaluationsPerCandidate,
    currentRun: null,
  };
  let population: CandidateEvaluation[] = [];
  let children: CandidateEvaluation[] = [];
  const emit = (): void =>
    options.onProgress?.({
      counters: { ...result.counters },
      budget,
      best: result.best
        ? {
            id: result.best.id,
            config: { ...result.best.config },
            score: result.best.score ? { ...result.best.score } : null,
          }
        : null,
      scope: evaluation.scope,
      scenarioHashes: [...evaluation.scenarioHashes],
      evaluationHash: evaluation.evaluationHash,
      evaluationsPerCandidate: evaluation.evaluationsPerCandidate,
      currentRun: result.currentRun ? { ...result.currentRun } : null,
    });
  const tournament = (): CandidateEvaluation => {
    const a = population[integer(rng, 0, population.length - 1)]!;
    const b = population[integer(rng, 0, population.length - 1)]!;
    return compareCandidates(a, b) <= 0 ? a : b;
  };
  const nextConfig = (): PolicyConfig => {
    // Identical starting candidates for both optimizers; all their simulations count.
    if (result.counters.proposals === 0) return withinSpace(BASELINE, parameterSpace);
    if (result.counters.proposals === 1) return withinSpace(QUEUE_AWARE, parameterSpace);
    if (method === 'random' || population.length < populationSize)
      return sampleConfigInSpace(rng, parameterSpace);
    return withinSpace(
      mutate(crossover(tournament().config, tournament().config, rng), rng),
      parameterSpace,
    );
  };
  outer: while (result.counters.simulations < budget && result.counters.proposals < maxProposals) {
    await yieldControl();
    if (options.shouldCancel?.()) {
      result.status = 'cancelled';
      break;
    }
    const config = nextConfig();
    result.counters.proposals++;
    const candidate: CandidateEvaluation = {
      id: result.counters.proposals,
      config,
      status: 'incomplete',
      score: null,
      runs: [],
      simulationsAtCompletion: result.counters.simulations,
    };
    result.records.push(candidate);
    for (const scenario of scenarios)
      for (const seed of seeds) {
        await yieldControl();
        if (options.shouldCancel?.()) {
          candidate.status = 'cancelled';
          result.status = 'cancelled';
          emit();
          break outer;
        }
        // This cache is private to one frozen evaluation. Exact scene indices identify
        // its validated content without retaining a full map string for every policy.
        // Horizon and code version are constant throughout this cache's lifetime.
        const key = stableStringify({ scene: scenarios.indexOf(scenario), config, seed });
        const cached = cache.get(key);
        if (cached) {
          result.counters.cacheHits++;
          candidate.runs.push(cached);
          continue;
        }
        if (result.counters.simulations >= budget) {
          result.status = 'budget-exhausted';
          break outer;
        }
        result.counters.simulations++;
        result.currentRun = { scenarioId: scenario.id, seed, tick: 0, horizon };
        emit();
        try {
          const run = options.simulate
            ? options.simulate(scenario, config, seed, horizon, codeVersion)
            : await runSimulationCooperatively(scenario, config, seed, horizon, codeVersion, {
                shouldCancel: options.shouldCancel,
                yieldControl,
                onTickProgress: (progress) => {
                  result.currentRun = progress;
                  emit();
                },
              });
          result.runs.push(run);
          candidate.runs.push(run);
          if (run.status !== 'completed') {
            candidate.status = run.status;
            result.status = run.status;
            if (run.status === 'failed') {
              candidate.error = run.error ?? 'Simulation failed';
              result.error = candidate.error;
            }
            emit();
            break outer;
          }
          if (
            run.horizon !== horizon ||
            run.metrics.ticks !== horizon ||
            run.scenarioHash !== contentHash(scenario)
          ) {
            throw new Error('Simulation returned a mismatched or incomplete evaluation');
          }
          cache.set(key, run);
          if (cache.size > SEARCH_CACHE_CAPACITY) cache.delete(cache.keys().next().value!);
        } catch (error) {
          candidate.status = 'failed';
          result.status = 'failed';
          candidate.error = error instanceof Error ? error.message : String(error);
          result.error = candidate.error;
          emit();
          break outer;
        }
        emit();
      }
    candidate.status = 'completed';
    candidate.score = aggregate(candidate.runs, horizon);
    candidate.simulationsAtCompletion = result.counters.simulations;
    if (!result.best || compareCandidates(candidate, result.best) < 0) result.best = candidate;
    result.history.push({
      simulations: result.counters.simulations,
      proposals: result.counters.proposals,
      bestScore: { ...result.best.score! },
      bestConfig: { ...result.best.config },
    });
    if (method === 'ga') {
      if (population.length < populationSize) population.push(candidate);
      else {
        children.push(candidate);
        if (children.length === populationSize - 1) {
          // Carry exactly one elite into the next generation. Its prior evaluation is
          // retained, not presented as a new actual simulation.
          const elite = [...population].sort(compareCandidates)[0]!;
          population = [elite, ...children];
          children = [];
        }
      }
    }
    emit();
  }
  if (
    result.status === 'completed' &&
    result.counters.simulations < budget &&
    result.counters.proposals >= maxProposals
  )
    result.status = 'proposal-limit';
  result.runtimeMs = performance.now() - startedAt;
  result.currentRun = null;
  emit();
  return result;
}

function withinSpace(config: PolicyConfig, space: SearchParameterSpace): PolicyConfig {
  const c = { ...config };
  if (!space.assignment.includes(c.assignment)) c.assignment = space.assignment[0]!;
  if (!space.priority.includes(c.priority)) c.priority = space.priority[0]!;
  if (!space.routing.includes(c.routing)) c.routing = space.routing[0]!;
  c.congestionWeight = clamp(c.congestionWeight, ...space.congestionWeight);
  c.planningWindow = clamp(c.planningWindow, ...space.planningWindow);
  c.replanInterval = clamp(c.replanInterval, ...space.replanInterval);
  // Distance routing has no active weight; zero is its canonical disabled value.
  return normalizeConfig(c);
}
export function sampleConfigInSpace(
  rng: () => number,
  space: SearchParameterSpace = DEFAULT_PARAMETER_SPACE,
): PolicyConfig {
  return normalizeConfig({
    assignment: space.assignment[integer(rng, 0, space.assignment.length - 1)]!,
    priority: space.priority[integer(rng, 0, space.priority.length - 1)]!,
    routing: space.routing[integer(rng, 0, space.routing.length - 1)]!,
    congestionWeight:
      space.congestionWeight[0] + rng() * (space.congestionWeight[1] - space.congestionWeight[0]),
    planningWindow: integer(rng, ...space.planningWindow),
    replanInterval: integer(rng, ...space.replanInterval),
  });
}
