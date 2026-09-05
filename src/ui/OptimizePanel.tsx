import { useState } from 'react';
import type { PolicyConfig, Scenario } from '../core/model/types';
import type { SearchProgress, SearchResult } from '../core/optimization/search';
import type { ComparisonResult, ComparisonProgress } from '../workers/search-protocol';
import type { FrozenEvaluation, SearchScope } from '../core/optimization/evaluation';
import { contentHash } from '../core/model/random';
import { Field, numberValue, fixed } from './fields';
export interface SearchSettings {
  scope: SearchScope;
  method: 'random' | 'ga';
  budget: number;
  horizon: number;
  optimizerSeed: number;
}
export default function OptimizePanel({
  scenario,
  progress,
  result,
  candidate,
  candidateTraining,
  comparison,
  compareProgress,
  active,
  onSearch,
  onCancel,
  onApply,
  onCompare,
  onExport,
  onImport,
}: {
  scenario: Scenario;
  progress: SearchProgress | null;
  result: SearchResult | null;
  candidate: PolicyConfig | null;
  candidateTraining: FrozenEvaluation | null;
  comparison: ComparisonResult | null;
  compareProgress: ComparisonProgress | null;
  active: 'search' | 'compare' | null;
  onSearch: (s: SearchSettings) => void;
  onCancel: () => void;
  onApply: () => void;
  onCompare: (horizon: number) => void;
  onExport: (kind: 'best' | 'results' | 'comparison') => void;
  onImport: () => void;
}) {
  const [scope, setScope] = useState<SearchScope>('current-factory'),
    [method, setMethod] = useState<'random' | 'ga'>('ga');
  const [budget, setBudget] = useState('6'),
    [horizon, setHorizon] = useState('240'),
    [optimizerSeed, setOptimizerSeed] = useState('7'),
    [error, setError] = useState('');
  const calls = scope === 'current-factory' ? 1 : 3;
  const horizonNumber = () => numberValue(horizon, 'Evaluation horizon', 1, 100000);
  const start = () => {
    try {
      const b = numberValue(budget, 'Simulation budget', 2 * calls, 3000);
      if (b % calls) throw new Error(`Budget must be divisible by ${calls}.`);
      onSearch({
        scope,
        method,
        budget: b,
        horizon: horizonNumber(),
        optimizerSeed: numberValue(optimizerSeed, 'Optimizer seed', 0, 4294967295),
      });
      setError('');
    } catch (e) {
      setError(String(e));
    }
  };
  const stale = result && result.evaluation.scenarioHashes[0] !== contentHash(scenario);
  return (
    <div className="panel-content">
      <h2>Configure a strategy</h2>
      <Field label="Search scope">
        <select
          aria-label="Search scope"
          value={scope}
          disabled={!!active}
          onChange={(e) => setScope(e.target.value as SearchScope)}
        >
          <option value="current-factory">Current factory</option>
          <option value="benchmark-set">Benchmark set</option>
        </select>
      </Field>
      <p className="muted">
        {scope === 'current-factory'
          ? `${scenario.name} · current edited layout`
          : 'Open floor, Crossroads and Hotspot dispatch'}
      </p>
      <p className="evaluation-cost">
        {calls} simulation{calls === 1 ? '' : 's'} per candidate · seed {scenario.seed}
      </p>
      <p className="muted">
        Higher mean orders per tick wins. Ties prefer fewer unfinished orders, then less traffic
        waiting. Every candidate uses the same layouts, seed and horizon.
      </p>
      <Field label="Search method">
        <select
          aria-label="Search method"
          value={method}
          disabled={!!active}
          onChange={(e) => setMethod(e.target.value as 'random' | 'ga')}
        >
          <option value="ga">Mixed-variable GA</option>
          <option value="random">Random search</option>
        </select>
      </Field>
      <p className="muted" data-testid="search-method-help">
        {method === 'random'
          ? 'Random search samples legal policy configurations independently.'
          : 'The GA selects better-scoring candidates, combines their discrete choices and continuous weight, then mutates them.'}{' '}
        Both methods start with the supplied Baseline and Queue aware presets.
      </p>
      <div className="field-pair">
        <Field label="Simulation budget">
          <input
            type="number"
            aria-label="Simulation budget"
            value={budget}
            disabled={!!active}
            onChange={(e) => setBudget(e.target.value)}
          />
        </Field>
        <Field label="Evaluation horizon">
          <input
            type="number"
            aria-label="Evaluation horizon"
            value={horizon}
            disabled={!!active}
            onChange={(e) => setHorizon(e.target.value)}
          />
        </Field>
      </div>
      {method === 'ga' && Number(budget) > 0 && Number(budget) <= 3 * calls && (
        <p className="muted" data-testid="search-budget-hint">
          Small budgets may only initialize the population. This search starts with three
          candidates, including two presets: {3 * calls} simulations without cache reuse. Allow
          more calls to explore offspring.
        </p>
      )}
      <Field label="Optimizer seed">
        <input
          type="number"
          aria-label="Optimizer seed"
          value={optimizerSeed}
          disabled={!!active}
          onChange={(e) => setOptimizerSeed(e.target.value)}
        />
      </Field>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button className="primary" data-testid="start-search" onClick={start} disabled={!!active}>
          Start search
        </button>
        {active && (
          <button onClick={onCancel} aria-label="Cancel">
            Cancel
          </button>
        )}
      </div>
      <div data-testid="search-progress" className="search-progress" aria-live="polite">
        {active === 'compare'
          ? `Comparing · ${compareProgress?.simulations ?? 0} / ${compareProgress?.total ?? 2} simulations`
          : progress
            ? `${progress.counters.simulations} / ${progress.budget} simulations · ${active ? 'running' : (result?.status ?? 'stopped')}`
            : 'Ready to search.'}
        {progress && (
          <>
            <progress max={progress.budget} value={progress.counters.simulations} />
            <span className="muted">
              {progress.counters.proposals} proposals · {progress.counters.cacheHits} cached
            </span>
            {active && progress.currentRun && (
              <span className="muted">
                {progress.currentRun.scenarioId} · tick {progress.currentRun.tick} /{' '}
                {progress.currentRun.horizon}
              </span>
            )}
          </>
        )}
      </div>
      {progress?.best && (
        <div className="best-score">
          <span>Best throughput</span>
          <strong>
            {fixed(progress.best.score?.throughput, 5)} <small>orders / tick</small>
          </strong>
        </div>
      )}
      {result && (
        <p
          className="result-origin"
          data-testid="result-origin"
          data-scope={result.evaluation.scope}
          data-scenario-hash={result.evaluation.scenarioHashes[0]}
        >
          {result.best && (
            <>
              <span data-testid="best-origin">
                Recorded search best:{' '}
                {result.best.id === 1
                  ? 'supplied Baseline preset'
                  : result.best.id === 2
                    ? 'supplied Queue aware preset'
                    : 'search proposal'}
                .
              </span>{' '}
            </>
          )}
          From {result.evaluation.scenarios.map((s) => s.name).join(', ')} ·{' '}
          {result.evaluation.horizon} ticks · seed {result.seeds.join(', ')}
          {stale && (
            <strong>
              Current factory differs. This score belongs to the recorded search layout.
            </strong>
          )}
        </p>
      )}
      <button
        className="full-width"
        data-testid="load-best"
        disabled={!candidate || !!active}
        onClick={onApply}
      >
        Apply candidate to current factory
      </button>
      {candidate && (
        <p className="muted" data-testid="candidate-origin">
          {candidateTraining
            ? `Candidate from ${candidateTraining.scenarios.map((s) => s.name).join(', ')} · ${candidateTraining.horizon} ticks · seed ${candidateTraining.seeds.join(', ')}`
            : 'Imported candidate; compare here to measure its performance.'}
        </p>
      )}
      <div className="button-row">
        <button disabled={!candidate} onClick={() => onExport('best')}>
          Export best
        </button>
        <button onClick={onImport}>Import candidate</button>
      </div>
      <button disabled={!result} onClick={() => onExport('results')}>
        Export search results
      </button>
      <hr />
      <h3>Compare on this factory</h3>
      <p className="muted">
        {scenario.name} · seed {scenario.seed} · {horizon || '—'} ticks. Both policies start from
        the same initial layout.
      </p>
      <button
        className="full-width"
        disabled={!candidate || !!active}
        onClick={() => {
          try {
            onCompare(horizonNumber());
            setError('');
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        Compare baseline vs candidate
      </button>
      {comparison && (
        <div data-testid="comparison">
          <p>
            {comparison.status} · {comparison.evaluation.horizon} ticks ·{' '}
            {comparison.evaluation.scenarios[0].name}
          </p>
          <table>
            <thead>
              <tr>
                <th>Metric</th>
                <th>Baseline</th>
                <th>Candidate</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Orders / tick</td>
                <td>{fixed(comparison.baselineScore?.throughput, 5)}</td>
                <td>{fixed(comparison.candidateScore?.throughput, 5)}</td>
              </tr>
              <tr>
                <td>Unfinished</td>
                <td>{fixed(comparison.baselineScore?.unfinishedOrders, 0)}</td>
                <td>{fixed(comparison.candidateScore?.unfinishedOrders, 0)}</td>
              </tr>
              <tr>
                <td>Oldest age</td>
                <td>{comparison.baseline[0]?.metrics.oldestUnfinishedAge ?? '—'}</td>
                <td>{comparison.candidate[0]?.metrics.oldestUnfinishedAge ?? '—'}</td>
              </tr>
            </tbody>
          </table>
          <button onClick={() => onExport('comparison')}>Export comparison</button>
        </div>
      )}
    </div>
  );
}
