import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stableStringify } from '../src/core/model/random';
import type { RunResult } from '../src/core/model/types';
import { parseBundle } from '../src/core/model/validation';
import { BASELINE } from '../src/core/policies/config';
import {
  compareScores,
  runSearch,
  type CandidateEvaluation,
  type SearchResult,
} from '../src/core/optimization/search';
import { runSimulationCooperatively, type SearchScope } from '../src/core/optimization/evaluation';
import { PRESETS, SUSTAINED } from '../src/scenarios';
import { codeVersion as getCodeVersion } from './version';

interface Arguments {
  quick: boolean;
  out: string;
  horizon: number;
  budget: number;
  optimizerSeeds: number[];
  evaluationSeeds: number[];
  input?: string;
  sustained: boolean;
}
function argumentsFor(argv: string[]): Arguments {
  let quick = true;
  let sustained = false;
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--quick') quick = true;
    else if (flag === '--full') quick = false;
    else if (flag === '--sustained') sustained = true;
    else if (
      [
        '--out',
        '--horizon',
        '--budget',
        '--optimizer-seeds',
        '--evaluation-seeds',
        '--input',
      ].includes(flag)
    ) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      values.set(flag, value);
    } else throw new Error(`Unknown argument ${flag}`);
  }
  const parseSeedList = (key: string, fallback: number[]): number[] => {
    const value = values.get(key);
    const seeds = value ? value.split(',').map(Number) : fallback;
    if (
      !seeds.length ||
      seeds.some((seed) => !Number.isInteger(seed) || seed < 0 || seed > 4294967295) ||
      new Set(seeds).size !== seeds.length
    )
      throw new Error(`${key} needs distinct comma-separated uint32 seeds (0–4294967295)`);
    return seeds;
  };
  const horizon = Number(values.get('--horizon') ?? (quick ? 240 : 600));
  const budget = Number(values.get('--budget') ?? (quick ? 18 : 144));
  if (!Number.isSafeInteger(horizon) || horizon < 1 || !Number.isSafeInteger(budget) || budget < 1)
    throw new Error('Horizon and budget must be positive safe integers');
  if (sustained && values.has('--input')) throw new Error('Choose --input or --sustained');
  return {
    quick,
    horizon,
    budget,
    sustained,
    input: values.get('--input'),
    out: resolve(
      values.get('--out') ?? `results/runs/${new Date().toISOString().replaceAll(':', '-')}`,
    ),
    optimizerSeeds: parseSeedList('--optimizer-seeds', quick ? [7] : [7, 19, 43]),
    evaluationSeeds: parseSeedList('--evaluation-seeds', quick ? [11] : [11, 29, 47]),
  };
}
function csvCell(value: unknown): string {
  if (value == null) return '';
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function makeCsv(
  searches: SearchResult[],
  heldout: RunResult | null,
  heldoutBaseline: RunResult | null,
): string {
  const headers = [
    'phase',
    'method',
    'optimizerSeed',
    'actualRunIndex',
    'scenarioId',
    'scenarioHash',
    'config',
    'seed',
    'horizon',
    'ticks',
    'completedOrders',
    'unfinishedOrders',
    'throughput',
    'meanDelay',
    'maxDelay',
    'oldestUnfinishedAge',
    'waitingRatio',
    'stationUtilization',
    'stalledTicks',
    'runtimeMs',
    'planningMs',
    'kernelVersion',
    'codeVersion',
    'stateHash',
    'status',
    'error',
  ];
  const rows: unknown[][] = [headers];
  const add = (
    r: RunResult,
    phase: string,
    method: string,
    optimizerSeed: number | null,
    index: number,
  ): void => {
    rows.push([
      phase,
      method,
      optimizerSeed,
      index,
      r.scenarioId,
      r.scenarioHash,
      r.config,
      r.seed,
      r.horizon,
      r.metrics.ticks,
      r.metrics.completedOrders,
      r.metrics.unfinishedOrders,
      r.metrics.throughput,
      r.metrics.meanDelay,
      r.metrics.maxDelay,
      r.metrics.oldestUnfinishedAge,
      r.metrics.waitingRatio,
      r.metrics.stationUtilization,
      r.metrics.stalledTicks,
      r.runtimeMs,
      r.planningMs,
      r.kernelVersion,
      r.codeVersion,
      r.stateHash,
      r.status,
      r.error,
    ]);
  };
  for (const search of searches)
    search.runs.forEach((r, i) => add(r, 'training', search.method, search.optimizerSeed, i + 1));
  if (heldout) add(heldout, 'heldout', 'frozen-selection', null, 1);
  if (heldoutBaseline) add(heldoutBaseline, 'heldout', 'baseline', null, 2);
  return rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}
const ranking = (a: CandidateEvaluation, b: CandidateEvaluation): number =>
  compareScores(a.score!, b.score!) ||
  stableStringify(a.config).localeCompare(stableStringify(b.config));

async function main(): Promise<void> {
  const args = argumentsFor(process.argv.slice(2));
  if (PRESETS.length < 4)
    throw new Error('Benchmark requires three training maps and a fourth heldout map');
  const scope: SearchScope = args.input ? 'current-factory' : 'benchmark-set';
  const trainingScenarios = args.input
    ? [parseBundle(JSON.parse(await readFile(resolve(args.input), 'utf8'))).scenario]
    : args.sustained
      ? [SUSTAINED]
      : PRESETS.slice(0, 3);
  const heldoutScenario = args.input || args.sustained ? null : PRESETS[3]!;
  const evaluationSize = trainingScenarios.length * args.evaluationSeeds.length;
  if (args.budget < evaluationSize * 2)
    throw new Error(
      `Budget must be at least ${evaluationSize * 2} to evaluate both shared human starting candidates`,
    );
  if (args.budget % evaluationSize !== 0)
    throw new Error(
      `Benchmark budget must be divisible by ${evaluationSize} for equally complete evaluation sets`,
    );
  const startedAt = performance.now();
  const codeVersion = getCodeVersion();
  let cancelled = false;
  process.once('SIGINT', () => {
    cancelled = true;
  });
  const searches: SearchResult[] = [];
  let heldout: RunResult | null = null;
  let heldoutBaseline: RunResult | null = null;
  let frozen: CandidateEvaluation | null = null;
  let error: string | null = null;
  console.log(
    `${args.quick ? 'Smoke validation' : 'Multi-seed benchmark'} (${scope}${args.sustained ? ', sustained demand' : ''}): ${args.horizon} ticks, ${args.budget} actual simulations per optimizer; ${trainingScenarios.length} maps × ${args.evaluationSeeds.length} seeds = ${evaluationSize} calls per candidate.`,
  );
  for (const optimizerSeed of args.optimizerSeeds) {
    for (const method of ['random', 'ga'] as const) {
      const result = await runSearch({
        method,
        scope,
        scenarios: trainingScenarios,
        seeds: args.evaluationSeeds,
        horizon: args.horizon,
        budget: args.budget,
        optimizerSeed,
        codeVersion,
        populationSize: args.quick ? 3 : 6,
        shouldCancel: () => cancelled,
      });
      searches.push(result);
      console.log(
        `${method} seed=${optimizerSeed}: status=${result.status}, simulations=${result.counters.simulations}/${result.budget}, proposals=${result.counters.proposals}, cacheHits=${result.counters.cacheHits}, best=${result.best?.score?.throughput ?? 'none'} orders/tick, ${Math.round(result.runtimeMs)} ms`,
      );
      if (result.status === 'failed') {
        error = result.error ?? 'Simulation correctness failure';
        break;
      }
      if (result.status !== 'completed') {
        error = `${method} stopped: ${result.status}`;
        break;
      }
    }
    if (error || cancelled) break;
  }
  // Freeze selection using training data only, then compare it with BASELINE on the
  // separate heldout map. Neither heldout result participates in selection.
  if (!error && !cancelled) {
    const candidates = searches.flatMap((search) =>
      search.records.filter((record) => record.status === 'completed' && record.score),
    );
    frozen = candidates.sort(ranking)[0] ?? null;
    if (frozen && heldoutScenario) {
      heldout = await runSimulationCooperatively(
        heldoutScenario,
        frozen.config,
        101,
        args.horizon,
        codeVersion,
        { shouldCancel: () => cancelled },
      );
      if (heldout.status !== 'completed') error = heldout.error ?? 'Heldout simulation failed';
      if (!error && !cancelled) {
        heldoutBaseline = await runSimulationCooperatively(
          heldoutScenario,
          BASELINE,
          101,
          args.horizon,
          codeVersion,
          { shouldCancel: () => cancelled },
        );
        if (heldoutBaseline.status !== 'completed')
          error = heldoutBaseline.error ?? 'Heldout baseline failed';
      }
      console.log(
        `Frozen selection heldout: ${heldout.metrics.completedOrders} completed, ${heldout.metrics.unfinishedOrders} unfinished, ${heldout.status}.`,
      );
    }
  }
  const totalRuntimeMs = performance.now() - startedAt;
  const record = {
    formatVersion: 2,
    mode: args.quick ? 'smoke-validation' : 'multi-seed-benchmark',
    timestamp: new Date().toISOString(),
    codeVersion,
    scope,
    demandMode: args.sustained
      ? 'sustained-pre-generated'
      : args.input
        ? 'custom-scene-conditions'
        : 'finite-batch',
    trainingScenarios,
    heldoutScenario,
    conditions: {
      horizon: args.horizon,
      evaluationSeeds: args.evaluationSeeds,
      optimizerSeeds: args.optimizerSeeds,
      actualSimulationBudgetPerSearch: args.budget,
      actualSimulationsPerCandidate: evaluationSize,
      heldoutSeed: heldoutScenario ? 101 : null,
      warmupTicks: 0,
    },
    objective:
      'Mean completedOrders / fixed horizon; ties: fewer unfinished orders, then less waiting. Canonical config provides stable exact ties.',
    initialization:
      'Both methods evaluate BASELINE and QUEUE_AWARE first. Their simulations count in each method budget. Each method has a fresh cache.',
    selection: heldoutScenario
      ? 'One final config selected across completed training evaluations, before matched candidate and baseline heldout runs. Heldout results never influence selection.'
      : 'Best config is selected only on the explicit evaluation scene(s). No independent heldout claim.',
    cancelled,
    error,
    totalRuntimeMs,
    actualSimulations:
      searches.reduce((n, s) => n + s.counters.simulations, 0) +
      (heldout ? 1 : 0) +
      (heldoutBaseline ? 1 : 0),
    searches,
    frozenConfig: frozen?.config ?? null,
    heldout,
    heldoutBaseline,
  };
  await mkdir(args.out, { recursive: true });
  await writeFile(resolve(args.out, 'benchmark.json'), JSON.stringify(record, null, 2) + '\n');
  await writeFile(resolve(args.out, 'runs.csv'), makeCsv(searches, heldout, heldoutBaseline));
  const summary = [
    `# WarehouseLab ${args.quick ? 'smoke validation' : 'multi-seed benchmark'}`,
    '',
    `Code version: ${codeVersion}. Actual total runtime: ${(totalRuntimeMs / 1000).toFixed(2)} seconds. Actual simulations: ${record.actualSimulations}.`,
    '',
    `Scope: ${scope}. All methods use the same ${trainingScenarios.length} explicit scene(s), evaluation seeds and fixed horizon (${evaluationSize} actual simulations per candidate). Human candidates are the first two configurations of each search and count in its budget.`,
    '',
    args.sustained
      ? 'Sustained demand uses the fixed 2,000-order stream in sustained-production. There is no warm-up exclusion: every completion through the horizon counts. Arrived unfinished orders and their oldest age expose backlog.'
      : 'Finite-batch/custom demand is stored in full with the result. Completed orders per horizon can saturate after all available orders finish; this is not evidence of a throughput ceiling under continuing demand.',
    '',
    '| Method | Optimizer seed | Actual calls | Proposals | Cache hits | Best orders/tick | Mean unfinished | Mean waiting | Status |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...searches.map(
      (s) =>
        `| ${s.method} | ${s.optimizerSeed} | ${s.counters.simulations} | ${s.counters.proposals} | ${s.counters.cacheHits} | ${s.best?.score?.throughput.toFixed(6) ?? '—'} | ${s.best?.score?.unfinishedOrders.toFixed(2) ?? '—'} | ${s.best?.score?.waitingRatio.toFixed(4) ?? '—'} | ${s.status} |`,
    ),
    '',
    'Human starting candidates (same conditions; these are included, not additional runs):',
    '',
    '| Optimizer seed | Candidate | Mean orders/tick | Mean unfinished | Mean waiting |',
    '| ---: | --- | ---: | ---: | ---: |',
    ...searches
      .filter((s) => s.method === 'random')
      .flatMap((s) =>
        s.records
          .slice(0, 2)
          .map(
            (r, i) =>
              `| ${s.optimizerSeed} | ${i === 0 ? 'BASELINE' : 'QUEUE_AWARE'} | ${r.score?.throughput.toFixed(6) ?? '—'} | ${r.score?.unfinishedOrders.toFixed(2) ?? '—'} | ${r.score?.waitingRatio.toFixed(4) ?? '—'} |`,
          ),
      ),
    '',
    heldout
      ? `Frozen selection on heldout map ${heldout.scenarioId}, seed ${heldout.seed}: ${heldout.metrics.completedOrders} completed orders, ${heldout.metrics.unfinishedOrders} unfinished, throughput ${heldout.metrics.throughput.toFixed(6)} orders/tick. Matched baseline: ${heldoutBaseline?.metrics.completedOrders ?? 'not completed'} orders. No reselection used this result; one comparison does not establish general improvement.`
      : heldoutScenario
        ? 'Heldout evaluation not run because selection did not finish.'
        : 'This scope has no heldout evaluation.',
    '',
    args.quick
      ? 'This small run is smoke validation only. It does not establish statistical significance, generalization or an optimizer advantage.'
      : 'This finite multi-seed experiment reports measured outcomes; it does not establish statistical significance or an optimizer advantage.',
    ...(error ? ['', `Failure/early stop: ${error}`] : []),
    '',
    'The JSON retains candidate records (including incomplete/error states), best-by-evaluation history, full scenario content, versions and all actual run details. CSV contains actual simulator invocations only.',
    '',
  ].join('\n');
  await writeFile(resolve(args.out, 'summary.md'), summary);
  console.log(
    `Saved JSON, CSV and summary to ${args.out}; total ${(totalRuntimeMs / 1000).toFixed(2)} s.`,
  );
  if (error || cancelled) process.exitCode = cancelled ? 130 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
