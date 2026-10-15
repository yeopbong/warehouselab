import { useEffect, useState } from 'react';
import type { SortingScenario } from './types';

interface Cost {
  started: number;
  simulationSeconds: number;
  trainingSeconds: number;
}
interface Group {
  scenarioId: string;
  regime: 'cold' | 'history';
  method: string;
  mean: number | null;
  interval95: [number, number] | null;
  optimizerRuns: number;
  simulationRuns: number;
  failedOptimizerRuns?: number;
  inProgressOptimizerRuns?: number;
}
interface GreedyReference {
  scenarioId: string;
  method: string;
  throughput: number | null;
  bySimulationSeed: Record<string, number>;
}
export interface ResearchResults {
  status: string;
  groups: Group[];
  finalResults: { scenarioId: string; phase: string }[];
  greedyReferences: GreedyReference[];
  originalEAReference?: {
    protocolHash: string;
    status?: string;
    groups?: Group[];
    greedyReferences?: GreedyReference[];
    costs?: Cost;
  };
  totalCost: Cost;
  totalResearchCost: Cost;
  overallStudyCost?: Cost;
  costsByPhase: Record<string, Cost>;
  uncertainty: string;
  scope: string;
}

const labels: Record<string, string> = {
  ea: 'Evolutionary search',
  simple: 'Simple surrogate',
  flat_aux: 'Pooled features + auxiliary',
  spatial: 'Spatial, score only',
  spatial_aux_top: 'Spatial + auxiliary, top batch',
  spatial_aux: 'Spatial + auxiliary, complementary batch',
  min_dist: 'Minimum-distance greedy',
  cluster: 'Cluster greedy',
  upstream_ea: 'Pinned upstream EA',
  upstream_min_dist: 'Upstream minimum-distance greedy',
  upstream_cluster: 'Upstream cluster greedy',
};
const fixed = (value: number | null | undefined, digits = 4) =>
  value == null ? '—' : value.toFixed(digits);

export default function MethodComparison({
  url,
  scenarios,
}: {
  url?: string;
  scenarios: SortingScenario[];
}) {
  const [results, setResults] = useState<ResearchResults | null>(null);
  const [condition, setCondition] = useState('');
  const [regime, setRegime] = useState('cold');
  useEffect(() => {
    let active = true;
    if (!url) {
      setResults(null);
      return;
    }
    const address = new URL(url, new URL(import.meta.env.BASE_URL, location.origin));
    if (address.origin !== location.origin) return;
    fetch(address)
      .then(async (response) => {
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json'))
          return;
        const record = (await response.json()) as ResearchResults;
        if (active && Array.isArray(record.groups) && record.groups.length) {
          setResults(record);
          setCondition(record.groups[0].scenarioId);
        }
      })
      .catch(() => {
        /* Optional results do not prevent browsing individual runs. */
      });
    return () => {
      active = false;
    };
  }, [url]);
  if (!results) return null;
  const conditions = [...new Set(results.groups.map((group) => group.scenarioId))];
  const rows = results.groups.filter(
    (group) => group.scenarioId === condition && group.regime === regime,
  );
  const selected = scenarios.find((scenario) => scenario.id === condition);
  const crossMap = results.finalResults.some(
    (row) => row.scenarioId === condition && row.phase === 'cross-final',
  );
  const history = results.costsByPhase['history-data'];
  const greedy = results.greedyReferences.filter((row) => row.scenarioId === condition);
  const upstreamRows =
    results.originalEAReference?.groups?.filter((row) => row.scenarioId === condition) ?? [];
  const upstreamGreedy =
    results.originalEAReference?.greedyReferences?.filter((row) => row.scenarioId === condition) ??
    [];
  const cost = results.overallStudyCost ?? results.totalResearchCost ?? results.totalCost;
  const completedRows = rows.filter((row) => row.optimizerRuns > 0);
  const maximumRuns = Math.max(0, ...completedRows.map((row) => row.optimizerRuns));
  const maximumSeeds = Math.max(
    0,
    ...completedRows.map((row) => row.simulationRuns / row.optimizerRuns),
  );
  return (
    <details className="sorting-card method-comparison" data-testid="method-comparison">
      <summary>
        <span>
          <span className="eyebrow">Independent final evaluation</span>
          <strong>Method comparison</strong>
        </span>
        <span className="sorting-muted">
          Inspect actual contrasts and their cost <span aria-hidden="true">↓</span>
        </span>
      </summary>
      <div className="method-comparison-body">
        <div className="sorting-form-row">
          <label>
            Test condition
            <select
              aria-label="Method comparison condition"
              value={condition}
              onChange={(event) => setCondition(event.target.value)}
            >
              {conditions.map((id) => (
                <option key={id} value={id}>
                  {scenarios.find((scenario) => scenario.id === id)?.name ?? id}
                </option>
              ))}
            </select>
          </label>
          <label>
            Learning setting
            <select
              aria-label="Method comparison setting"
              value={regime}
              onChange={(event) => setRegime(event.target.value)}
            >
              <option value="cold">Cold start</option>
              <option value="history">Historical training data</option>
            </select>
          </label>
        </div>
        <p className="sorting-muted">
          {crossMap
            ? 'Separate cross-map reoptimization test.'
            : 'Unseen demand or fleet conditions on the same physical map.'}{' '}
          {selected?.horizon ? `${selected.horizon.toLocaleString()} ticks per run. ` : ''}Selection
          and final evaluation use different simulation seeds.{' '}
          {results.status !== 'completed'
            ? 'These are the completed observations from a study still in progress.'
            : ''}
        </p>
        <div className="sorting-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Method</th>
                <th>Mean parcels / tick</th>
                <th>Descriptive 95% interval</th>
                <th>Optimizer runs</th>
                <th>Final simulations</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.method}>
                  <td>{labels[row.method] ?? row.method.replaceAll('_', ' ')}</td>
                  <td>{fixed(row.mean)}</td>
                  <td>
                    {row.interval95
                      ? `${fixed(row.interval95[0])} – ${fixed(row.interval95[1])}`
                      : '—'}
                  </td>
                  <td>
                    {row.optimizerRuns}
                    {row.failedOptimizerRuns ? ` · ${row.failedOptimizerRuns} failed` : ''}
                    {row.inProgressOptimizerRuns ? ` · ${row.inProgressOptimizerRuns} running` : ''}
                  </td>
                  <td>{row.simulationRuns}</td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={5}>No completed measurements for this setting.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {greedy.length > 0 && (
          <p className="sorting-muted">
            Fixed greedy references on this condition:{' '}
            {greedy
              .map(
                (row) =>
                  `${labels[row.method] ?? row.method.replaceAll('_', ' ')} ${fixed(row.throughput)} (${Object.keys(row.bySimulationSeed).length} final seeds)`,
              )
              .join('; ')}
            . These are separately measured mappings, not free optimized initializations.
          </p>
        )}
        {upstreamRows.length > 0 && (
          <section className="upstream-reference" aria-label="Pinned upstream EA comparison">
            <h3>Upstream EA · matched budget</h3>
            <p className="sorting-muted">
              A separate cold-start comparison using the pinned upstream emitter, the same corrected
              simulator and evaluation budget. Repair ties are deterministic. These observations are
              distinct from the evolutionary search baseline above.
            </p>
            <div className="sorting-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>Mean parcels / tick</th>
                    <th>Descriptive 95% interval</th>
                    <th>Optimizer runs</th>
                    <th>Final simulations</th>
                  </tr>
                </thead>
                <tbody>
                  {upstreamRows.map((row) => (
                    <tr key={row.method}>
                      <td>{labels[row.method] ?? row.method.replaceAll('_', ' ')}</td>
                      <td>{fixed(row.mean)}</td>
                      <td>
                        {row.interval95
                          ? `${fixed(row.interval95[0])} – ${fixed(row.interval95[1])}`
                          : '—'}
                      </td>
                      <td>{row.optimizerRuns}</td>
                      <td>{row.simulationRuns}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {upstreamGreedy.length > 0 && (
              <p className="sorting-muted">
                {upstreamGreedy
                  .map(
                    (row) =>
                      `${labels[row.method] ?? row.method.replaceAll('_', ' ')} ${fixed(row.throughput)} (${Object.keys(row.bySimulationSeed).length} final seeds)`,
                  )
                  .join('; ')}
                .
              </p>
            )}
            {results.originalEAReference?.costs && (
              <p className="sorting-muted">
                This supplemental comparison uses{' '}
                {results.originalEAReference.costs.started.toLocaleString()} true calls across all
                its conditions, included in the reported study total.
              </p>
            )}
          </section>
        )}
        <p className="sorting-muted">
          {results.uncertainty}{' '}
          {completedRows.length
            ? `Completed rows contain up to ${maximumRuns} independent optimization runs, each followed by ${maximumSeeds} independent final simulation seeds.`
            : ''}
        </p>
        {regime === 'history' && (
          <p className="sorting-note">
            Historical learning additionally uses {history?.started ?? 0} offline simulation calls
            {history
              ? ` (${fixed(history.simulationSeconds, 1)} simulation seconds; ${fixed(history.trainingSeconds, 1)} training seconds)`
              : ''}
            . This cost is outside each online search budget and is charged once in the reported
            total. EA remains a cold-start reference.
          </p>
        )}
        <div className="research-cost">
          <span>
            Reported study: <strong>{cost.started.toLocaleString()} true calls</strong>
          </span>
          <span>{fixed(cost.simulationSeconds / 60, 1)} min simulation</span>
          <span>{fixed(cost.trainingSeconds / 60, 1)} min training</span>
          <a
            href="https://github.com/yeopbong/warehouselab/blob/main/results/tmo/summary.json"
            target="_blank"
            rel="noreferrer"
          >
            Full protocol and results ↗
          </a>
        </div>
      </div>
    </details>
  );
}
