import { useEffect, useRef, useState } from 'react';
import {
  cancelJob,
  evaluateMapping,
  getCatalog,
  getJob,
  getStudy,
  serviceStatus,
  startSearch,
} from './client';
import { changedChutes, mappingCounts, mappingErrors, parseSeeds } from './mapping';
import { parseStudyRecord } from './records';
import type { Candidate, Catalog, Job, ServiceStatus, Study } from './types';
import CandidateCurve from './CandidateCurve';
import MappingEditor from './MappingEditor';
import MethodComparison from './MethodComparison';
import PredictionPanel from './PredictionPanel';
import SortingMap from './SortingMap';
import RunComparison from './RunComparison';
import './sorting.css';

const number = (value: number | null | undefined, digits = 3) =>
  value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits);
const methodName = (method: string) =>
  ({
    greedy: 'Greedy initialization',
    random: 'Random search',
    ea: 'Evolutionary search',
    simple: 'Simple surrogate',
    flat_aux: 'Pooled features + auxiliary',
    spatial: 'Spatial, score only',
    spatial_aux_top: 'Spatial + auxiliary, top batch',
    spatial_aux: 'Spatial + auxiliary, complementary batch',
  })[method] ?? method.replaceAll('_', ' ').replaceAll('-', ' ');
const running = (status: string) => ['queued', 'running', 'cancelling'].includes(status);

function integer(value: string, label: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!value.trim() || !Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  return parsed;
}
function saveRecord(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function SortingApp() {
  const [service, setService] = useState<ServiceStatus | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [study, setStudy] = useState<Study | null>(null);
  const [source, setSource] = useState<'saved' | 'live' | 'imported'>('saved');
  const [selectedId, setSelectedId] = useState('');
  const [selectedDestination, setSelectedDestination] = useState('');
  const [selectedChute, setSelectedChute] = useState<number | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [conditionId, setConditionId] = useState('');
  const [method, setMethod] = useState('spatial_aux');
  const [regime, setRegime] = useState<'cold-start' | 'history'>('cold-start');
  const [historyIds, setHistoryIds] = useState<string[]>([]);
  const [budget, setBudget] = useState('24');
  const [batchSize, setBatchSize] = useState('3');
  const [optimizerSeed, setOptimizerSeed] = useState('7');
  const [seeds, setSeeds] = useState('11, 29');
  const [horizon, setHorizon] = useState('1000');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [tab, setTab] = useState<'mapping' | 'comparison' | 'prediction'>('mapping');
  const [compareA, setCompareA] = useState<Candidate | null>(null);
  const [compareB, setCompareB] = useState<Candidate | null>(null);
  const [compareAStudy, setCompareAStudy] = useState<Study | null>(null);
  const [compareBStudy, setCompareBStudy] = useState<Study | null>(null);
  const [pinnedA, setPinnedA] = useState(false);
  const [help, setHelp] = useState(false);
  const request = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const candidate =
    study?.candidates.find((value) => value.id === selectedId) ?? study?.candidates.at(-1) ?? null;
  const target =
    catalog?.scenarios.find((value) => value.id === conditionId) ?? study?.scenario ?? null;
  const ready = service?.available === true && service.simulator.ready;
  const busy = submitting || !!(job && running(job.status));
  const changes = candidate ? changedChutes(candidate.mapping, draft) : [];
  const sameMap =
    !!study &&
    target?.map.id === study.scenario.map.id &&
    target.map.chutes.length === draft.length;

  function acceptStudy(next: Study, origin: typeof source, preserve = false) {
    setStudy(next);
    setSource(origin);
    if (!preserve) {
      const first =
        [...next.candidates].reverse().find((value) => value.throughput != null) ??
        next.candidates[0];
      setSelectedId(first?.id ?? '');
      setDraft(first?.mapping ?? []);
      setSelectedChute(null);
      setSelectedDestination(next.scenario.destinations[0]?.id ?? '');
      setConditionId(next.scenario.id);
      setHorizon(String(next.scenario.horizon));
      if (!pinnedA) {
        setCompareA(
          next.candidates.find((value) =>
            value.evaluations.some((evaluation) => evaluation.traceUrl),
          ) ?? null,
        );
        setCompareAStudy(next);
      }
      setCompareB(
        [...next.candidates]
          .reverse()
          .find((value) => value.evaluations.some((evaluation) => evaluation.traceUrl)) ??
          first ??
          null,
      );
      setCompareBStudy(next);
    }
  }

  useEffect(() => {
    let alive = true;
    const token = ++request.current;
    (async () => {
      const status = await serviceStatus();
      const index = await getCatalog(!!status?.available);
      if (!alive || token !== request.current) return;
      setService(status);
      setCatalog(index);
      setConditionId(index.scenarios[0]?.id ?? '');
      if (index.scenarios[0]) setHorizon(String(index.scenarios[0].horizon));
      const id = index.defaultStudyId ?? index.studies[0]?.id;
      if (id) {
        const next = await getStudy(id, !!status?.available);
        if (alive && token === request.current)
          acceptStudy(next, status?.available ? 'live' : 'saved');
      }
    })()
      .catch((failure) => {
        if (alive) setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!job || !running(job.status)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const token = request.current;
    const poll = async () => {
      try {
        const nextJob = await getJob(job.id);
        if (nextJob.status === 'queued') {
          if (!stopped && token === request.current) timer = setTimeout(poll, 900);
          return;
        }
        let nextStudy: Study;
        try {
          nextStudy = await getStudy(nextJob.studyId, true);
        } catch (failure) {
          if (!running(nextJob.status)) {
            if (!stopped && token === request.current) {
              setJob(nextJob);
              setError(
                nextJob.error ?? (failure instanceof Error ? failure.message : String(failure)),
              );
              setNotice(`Job ${nextJob.status}. No completed study is available.`);
            }
            return;
          }
          throw failure;
        }
        if (stopped || token !== request.current) return;
        setJob(nextJob);
        setStudy(nextStudy);
        setError(nextJob.error ?? '');
        setSource('live');
        setCompareAStudy((previous) => (previous?.id === nextStudy.id ? nextStudy : previous));
        setCompareBStudy((previous) => (previous?.id === nextStudy.id ? nextStudy : previous));
        setCompareA((previous) =>
          compareAStudy?.id === nextStudy.id
            ? (nextStudy.candidates.find((value) => value.id === previous?.id) ?? previous)
            : previous,
        );
        setCompareB((previous) =>
          compareBStudy?.id === nextStudy.id
            ? (nextStudy.candidates.find((value) => value.id === previous?.id) ?? previous)
            : previous,
        );
        if (!selectedId && nextStudy.candidates.length) {
          const first = nextStudy.candidates[0];
          setSelectedId(first.id);
          setDraft(first.mapping);
          setSelectedDestination(nextStudy.scenario.destinations[0]?.id ?? '');
          if (!pinnedA) {
            setCompareA(first);
            setCompareAStudy(nextStudy);
          }
          setCompareB(first);
          setCompareBStudy(nextStudy);
        }
        if (running(nextJob.status)) timer = setTimeout(poll, 900);
        else {
          setNotice(
            nextJob.status === 'completed'
              ? 'Evaluation finished. Select a candidate to inspect its measured result.'
              : `Job ${nextJob.status}. Started calls remain in the record.`,
          );
          if (nextJob.error) setError(nextJob.error);
          setCatalog(await getCatalog(true));
        }
      } catch (failure) {
        if (!stopped) {
          setError(failure instanceof Error ? failure.message : String(failure));
          timer = setTimeout(poll, 2500);
        }
      }
    };
    timer = setTimeout(poll, 500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [job?.id, job?.status, selectedId]);

  async function loadStudy(id: string) {
    const token = ++request.current;
    setLoading(true);
    setError('');
    try {
      const next = await getStudy(id, !!service?.available);
      if (token === request.current) acceptStudy(next, service?.available ? 'live' : 'saved');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (token === request.current) setLoading(false);
    }
  }

  function selectCandidate(id: string) {
    const next = study?.candidates.find((value) => value.id === id);
    if (!next) return;
    setSelectedId(id);
    setDraft(next.mapping);
    setSelectedChute(null);
    setNotice('');
  }

  async function submit(kind: 'search' | 'evaluate') {
    setError('');
    setNotice('');
    if (!target || !ready) return;
    setSubmitting(true);
    try {
      const simulationSeeds = parseSeeds(seeds);
      let receipt;
      if (kind === 'evaluate') {
        if (source === 'imported')
          throw new Error('Load a saved experiment from the library before evaluating edits.');
        if (!sameMap || !candidate)
          throw new Error(
            'Choose a condition with the same physical map before testing this mapping.',
          );
        const problems = mappingErrors(study!.scenario, draft);
        if (problems.length) throw new Error(problems.join(' '));
        receipt = await evaluateMapping({
          scenarioId: target.id,
          mapping: draft,
          simulationSeeds,
          horizon: integer(horizon, 'Horizon', 1, 10000),
          sourceStudyId: study!.id,
          sourceCandidateId: candidate.id,
        });
      } else {
        if (regime === 'history' && !historyIds.length)
          throw new Error('Select completed training studies for historical learning.');
        receipt = await startSearch({
          scenarioId: target.id,
          method,
          budget: integer(budget, 'Simulation budget', 1, 200),
          batchSize: integer(batchSize, 'Batch size', 1, 10),
          optimizerSeed: integer(optimizerSeed, 'Optimizer seed', 0, 4294967295),
          simulationSeeds,
          regime,
          historyStudyIds: regime === 'history' ? historyIds : [],
        });
      }
      ++request.current;
      setJob({ id: receipt.jobId, studyId: receipt.studyId, status: 'queued', progress: null });
      setSelectedId('');
      setDraft([]);
      if (kind === 'evaluate' && candidate && study) {
        setCompareA(candidate);
        setCompareAStudy(study);
        setPinnedA(true);
      } else if (!pinnedA) {
        setCompareA(null);
        setCompareAStudy(null);
      }
      setCompareB(null);
      setCompareBStudy(null);
      setStudy(null);
      setSource('live');
      setNotice(
        'Submitted to the local simulator. Results appear only after real evaluations complete.',
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSubmitting(false);
    }
  }

  const sorted = study?.candidates.filter((value) => value.throughput != null) ?? [];
  const best = sorted.length ? Math.max(...sorted.map((value) => value.throughput!)) : null;
  const counts =
    study && draft.length ? mappingCounts(study.scenario, draft) : new Map<string, number>();
  const selectedDestinationRecord = study?.scenario.destinations.find(
    (value) => value.id === selectedDestination,
  );
  const completed =
    candidate?.evaluations.filter((evaluation) => evaluation.status === 'completed') ?? [];

  return (
    <div
      className="sorting-app"
      data-testid="sorting-workspace"
      data-mode={ready ? 'live' : 'saved'}
    >
      <header className="sorting-header">
        <a href="#sorting" className="sorting-brand">
          <span className="sorting-mark">W</span>
          <span>
            WarehouseLab<small>Sorting research</small>
          </span>
        </a>
        <nav>
          <span className={`sorting-connection ${ready ? 'online' : ''}`}>
            <i />
            {loading && !catalog
              ? 'Loading records'
              : ready
                ? 'Local simulator connected'
                : 'Saved experiments'}
          </span>
          <a href="#factory">Factory workspace ↗</a>
          <button onClick={() => setHelp(!help)} aria-expanded={help}>
            How it works
          </button>
          <a href="https://github.com/yeopbong/warehouselab" target="_blank" rel="noreferrer">
            Source ↗
          </a>
        </nav>
      </header>

      {help && (
        <section className="sorting-help">
          <div>
            <span className="eyebrow">Destination-to-chutes task mapping</span>
            <h2>Choose a mapping. Measure the consequences.</h2>
            <p>
              Each chute serves one destination. A legal mapping respects every destination’s quota.
              The original multi-robot simulator measures sorted parcels and operational events; a
              shared predictor learns from completed runs to guide subsequent candidate search.
            </p>
          </div>
          <div>
            <p>
              Search compares improvement potential, predictive uncertainty and complementary
              spatial effects. Operational prediction errors remain visible alongside successes.
              Geometry, predictions and measurements are kept separate.
            </p>
            <p>
              Recorded studies can be inspected here. New evaluations require the local service and
              always start from the initial state. A new demand or fleet condition can test a fixed
              mapping or start a separate optimization.
            </p>
          </div>
        </section>
      )}

      <main className="sorting-shell">
        <aside className="sorting-sidebar">
          <section className="sorting-card">
            <span className="eyebrow">Experiment library</span>
            <h1>Explore a study</h1>
            <label>
              Recorded experiment
              <select
                aria-label="Recorded experiment"
                value={study?.id ?? ''}
                disabled={loading || busy || !catalog?.studies.length}
                onChange={(event) => void loadStudy(event.target.value)}
              >
                <option value="" disabled>
                  {catalog?.studies.length ? 'Select experiment' : 'No saved experiments'}
                </option>
                {catalog?.studies.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
            {study && (
              <div className="study-summary">
                <strong>{study.name}</strong>
                <span>{methodName(study.method)}</span>
                <div>
                  <span className="sorting-badge">{study.regime}</span>
                  <span className="sorting-badge">
                    {source === 'live' && running(study.status)
                      ? 'Executing'
                      : source === 'imported'
                        ? 'Imported record'
                        : 'Saved result'}
                  </span>
                </div>
              </div>
            )}
            <div className="sorting-form-row">
              <button
                disabled={!study}
                onClick={() => study && saveRecord(`${study.id}.json`, study)}
              >
                Export record
              </button>
              <button onClick={() => input.current?.click()} disabled={busy}>
                Import record
              </button>
            </div>
          </section>

          <section className="sorting-card experiment-controls" aria-label="Experiment controls">
            <span className="eyebrow">Next experiment</span>
            <h2>Evaluate a condition</h2>
            <label>
              Demand and fleet
              <select
                aria-label="Demand and fleet condition"
                value={conditionId}
                disabled={busy || !catalog?.scenarios.length}
                onChange={(event) => {
                  setConditionId(event.target.value);
                  const condition = catalog?.scenarios.find(
                    (value) => value.id === event.target.value,
                  );
                  if (condition) setHorizon(String(condition.horizon));
                }}
              >
                {catalog?.scenarios.map((scenario) => (
                  <option value={scenario.id} key={scenario.id}>
                    {scenario.name}
                  </option>
                ))}
              </select>
            </label>
            {target && (
              <p className="sorting-muted">
                {target.fleetSize} robots · {target.destinations.length} destinations ·{' '}
                {target.map.chutes.length} chutes
                <br />
                {target.map.width} × {target.map.height} cells · {target.horizon.toLocaleString()}{' '}
                search ticks
              </p>
            )}
            {study && conditionId !== study.scenario.id && (
              <p className="sorting-note">
                Viewing results from {study.scenario.name}. The selected condition has no new
                measurements yet.
              </p>
            )}
            <label>
              Simulation seeds
              <input
                aria-label="Simulation seeds"
                value={seeds}
                disabled={busy}
                onChange={(event) => setSeeds(event.target.value)}
              />
            </label>
            <label>
              Fixed-map evaluation horizon
              <input
                aria-label="Fixed-map evaluation horizon"
                type="number"
                min="1"
                value={horizon}
                disabled={busy}
                onChange={(event) => setHorizon(event.target.value)}
              />
            </label>
            <button
              className="sorting-secondary-action"
              disabled={
                !ready ||
                source === 'imported' ||
                busy ||
                !candidate ||
                !sameMap ||
                !!(study && mappingErrors(study.scenario, draft).length)
              }
              onClick={() => void submit('evaluate')}
            >
              Evaluate fixed mapping
            </button>
            <p className="sorting-muted">
              {study &&
              (conditionId !== study.scenario.id ||
                study.scenario.constraintMode === 'fixed-mapping')
                ? 'Fixed mapping test: allocation quotas from the original condition are retained. '
                : 'Uses the selected mapping, including legal edits. '}
              Each simulation seed is a separately counted run.
            </p>
            {source === 'imported' && (
              <p className="sorting-note">
                Imported records are read-only. Load a saved experiment from the library to evaluate
                edits. A new search below does not use the imported measurements.
              </p>
            )}
            <div className="sorting-rule" />
            <h2>Search for a mapping</h2>
            <label>
              Search method
              <select
                aria-label="Mapping search method"
                value={method}
                disabled={busy}
                onChange={(event) => setMethod(event.target.value)}
              >
                {['ea', 'simple', 'flat_aux', 'spatial', 'spatial_aux_top', 'spatial_aux'].map(
                  (id) => (
                    <option key={id} value={id}>
                      {methodName(id)}
                    </option>
                  ),
                )}
              </select>
            </label>
            <div className="sorting-form-row">
              <label>
                Simulation budget
                <input
                  aria-label="Mapping simulation budget"
                  type="number"
                  min="2"
                  value={budget}
                  disabled={busy}
                  onChange={(event) => setBudget(event.target.value)}
                />
              </label>
              <label>
                Batch size
                <input
                  aria-label="Mapping batch size"
                  type="number"
                  min="1"
                  value={batchSize}
                  disabled={busy}
                  onChange={(event) => setBatchSize(event.target.value)}
                />
              </label>
            </div>
            <label>
              Optimizer seed
              <input
                aria-label="Mapping optimizer seed"
                type="number"
                min="0"
                value={optimizerSeed}
                disabled={busy}
                onChange={(event) => setOptimizerSeed(event.target.value)}
              />
            </label>
            <label>
              Learning setting
              <select
                aria-label="Learning setting"
                value={regime}
                disabled={busy}
                onChange={(event) => setRegime(event.target.value as typeof regime)}
              >
                <option value="cold-start">Cold start · current budget only</option>
                <option value="history">Use recorded training history</option>
              </select>
            </label>
            {regime === 'history' && (
              <div className="history-picker" aria-label="Training history">
                {catalog?.studies
                  .filter((value) => value.status === 'completed')
                  .map((entry) => (
                    <label key={entry.id}>
                      <input
                        type="checkbox"
                        checked={historyIds.includes(entry.id)}
                        disabled={busy}
                        onChange={(event) =>
                          setHistoryIds(
                            event.target.checked
                              ? [...historyIds, entry.id]
                              : historyIds.filter((id) => id !== entry.id),
                          )
                        }
                      />
                      {entry.name}
                    </label>
                  ))}
              </div>
            )}
            <button
              className="sorting-primary"
              disabled={!ready || busy || !target}
              onClick={() => void submit('search')}
            >
              Optimize for this condition <span>↗</span>
            </button>
            {!ready && (
              <p className="sorting-note">
                This page browses saved runs. Start the local research service to execute the
                original simulator and train new models.
              </p>
            )}
            {busy && job && (
              <div className="sorting-job" role="status">
                <strong>{job.status} · local evaluation</strong>
                <span>
                  {study
                    ? `${study.costs.started} / ${study.budget} calls started`
                    : 'Waiting for the first result…'}
                </span>
                <button
                  onClick={() =>
                    void cancelJob(job.id)
                      .then(setJob)
                      .catch((failure) => setError(String(failure)))
                  }
                >
                  Cancel after current simulation
                </button>
              </div>
            )}
          </section>
        </aside>

        <div className="sorting-main">
          <div className="sorting-intro">
            <div>
              <span className="eyebrow">Learning from real simulation</span>
              <h1>A mapping is a hypothesis.</h1>
              <p>Follow the search, inspect its predictions, and replay what actually happened.</p>
            </div>
            <span className="sorting-version">
              TMO simulation
              <br />
              Constrained mapping search
            </span>
          </div>
          {error && (
            <div className="sorting-alert" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="sorting-notice" role="status">
              {notice}
            </div>
          )}
          <MethodComparison url={catalog?.resultsUrl} scenarios={catalog?.scenarios ?? []} />
          {loading ? (
            <div className="sorting-empty">
              <span className="loading-line" />
              <h2>Loading the experiment record</h2>
              <p>Mappings, predictions and measurements are loaded together.</p>
            </div>
          ) : !study ? (
            <div className="sorting-empty">
              <h2>{busy ? 'The experiment is running' : 'No recorded study is available'}</h2>
              <p>
                {busy
                  ? 'Completed candidates will appear after the simulator returns a measured result.'
                  : 'Load an exported study, or connect the local service and start a real evaluation.'}
              </p>
            </div>
          ) : (
            <>
              <section className="sorting-stats" aria-label="Study costs">
                <div>
                  <span>Best measured throughput</span>
                  <strong>
                    {number(best, 4)}
                    <small> parcels / tick</small>
                  </strong>
                </div>
                <div>
                  <span>True simulation calls</span>
                  <strong>
                    {study.costs.started}
                    <small> / {study.budget} budget</small>
                  </strong>
                </div>
                <div>
                  <span>Simulation time</span>
                  <strong>
                    {number(study.costs.simulationSeconds, 1)}
                    <small> seconds</small>
                  </strong>
                </div>
                <div>
                  <span>Model training</span>
                  <strong>
                    {number(study.costs.trainingSeconds, 2)}
                    <small> seconds</small>
                  </strong>
                </div>
              </section>
              <section className="sorting-card curve-card">
                <div className="sorting-card-heading">
                  <div>
                    <span className="eyebrow">Search trajectory</span>
                    <h2>Select a measured candidate</h2>
                  </div>
                  <span className="sorting-muted">
                    {study.candidates.length} candidates · {study.costs.cacheHits} cache hits ·{' '}
                    {study.costs.failed} failed
                  </span>
                </div>
                <CandidateCurve
                  candidates={study.candidates}
                  selectedId={candidate?.id}
                  onSelect={selectCandidate}
                />
              </section>
              <div className="sorting-workspace-header">
                <div role="tablist" aria-label="Candidate view">
                  {[
                    ['mapping', 'Mapping'],
                    ['comparison', 'Run comparison'],
                    ['prediction', 'Prediction errors'],
                  ].map(([id, label]) => (
                    <button
                      role="tab"
                      key={id}
                      aria-selected={tab === id}
                      onClick={() => setTab(id as typeof tab)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label className="candidate-select">
                  Candidate
                  <select
                    aria-label="Selected candidate"
                    value={candidate?.id ?? ''}
                    onChange={(event) => selectCandidate(event.target.value)}
                  >
                    {study.candidates.map((value) => (
                      <option key={value.id} value={value.id}>
                        {value.id} ·{' '}
                        {value.throughput == null
                          ? 'Unmeasured'
                          : `${number(value.throughput, 4)} parcels/tick`}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {candidate && tab === 'mapping' && (
                <div className="mapping-layout">
                  <section className="sorting-card map-card">
                    <div className="sorting-card-heading">
                      <div>
                        <h2>
                          {changes.length
                            ? 'Edited mapping · not evaluated'
                            : `${candidate.id} · ${candidate.throughput == null ? 'unmeasured' : 'measured'} mapping`}
                        </h2>
                        <p className="sorting-muted">
                          {study.scenario.name} · {candidate.operation}
                        </p>
                      </div>
                      <label>
                        Highlight destination
                        <select
                          aria-label="Highlight destination"
                          value={selectedDestination}
                          onChange={(event) => setSelectedDestination(event.target.value)}
                        >
                          {study.scenario.destinations.map((destination) => (
                            <option key={destination.id} value={destination.id}>
                              {destination.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <SortingMap
                      scenario={study.scenario}
                      mapping={draft}
                      selectedDestination={selectedDestination}
                      selectedChute={selectedChute}
                      changed={changes.length ? changes : candidate.changedChutes}
                      onChute={setSelectedChute}
                    />
                    {selectedDestinationRecord && (
                      <div className="destination-facts">
                        <strong>{selectedDestinationRecord.label}</strong>
                        <span>
                          {counts.get(selectedDestination) ?? 0} chutes · quota{' '}
                          {selectedDestinationRecord.minChutes}–
                          {selectedDestinationRecord.maxChutes}
                        </span>
                        <span>Demand weight {number(selectedDestinationRecord.weight, 3)}</span>
                        <span>
                          {selectedDestinationRecord.recirculation
                            ? 'Recirculation destination'
                            : 'Normal destination'}
                        </span>
                      </div>
                    )}
                  </section>
                  <div className="mapping-side">
                    <section
                      className="sorting-card candidate-detail"
                      aria-label="Selected candidate details"
                    >
                      <span className="eyebrow">Candidate {candidate.id}</span>
                      <h2>Prediction meets measurement</h2>
                      <dl>
                        <div>
                          <dt>Predicted throughput</dt>
                          <dd>{number(candidate.prediction?.mean, 4)}</dd>
                        </div>
                        <div>
                          <dt>Model disagreement</dt>
                          <dd>
                            {candidate.prediction
                              ? `± ${number(candidate.prediction.std, 4)}`
                              : '—'}
                          </dd>
                        </div>
                        <div>
                          <dt>Measured throughput</dt>
                          <dd>{number(candidate.throughput, 4)}</dd>
                        </div>
                        <div>
                          <dt>Completed evaluations</dt>
                          <dd>
                            {completed.length} / {candidate.evaluations.length}
                          </dd>
                        </div>
                        <div>
                          <dt>Elapsed simulation</dt>
                          <dd>
                            {number(
                              candidate.evaluations.reduce(
                                (sum, evaluation) => sum + evaluation.wallSeconds,
                                0,
                              ),
                              2,
                            )}{' '}
                            s
                          </dd>
                        </div>
                        <div>
                          <dt>Calls after evaluation</dt>
                          <dd>{candidate.calls}</dd>
                        </div>
                      </dl>
                      <p className="sorting-muted">
                        Throughput is sorted parcels per simulator tick. Uncertainty is a model
                        estimate, not a confidence interval on the measured mean.
                      </p>
                      {candidate.acquisition && (
                        <details>
                          <summary>Why this candidate was selected</summary>
                          <dl>
                            {Object.entries(candidate.acquisition).map(([key, value]) => (
                              <div key={key}>
                                <dt>{key}</dt>
                                <dd>
                                  {typeof value === 'number'
                                    ? number(value, 4)
                                    : String(value ?? '—')}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </details>
                      )}
                      <div className="sorting-form-row">
                        <button
                          onClick={() => {
                            setCompareA(candidate);
                            setCompareAStudy(study);
                            setPinnedA(true);
                            setNotice(
                              `${candidate.id} pinned as run A. Select another study or candidate to compare as B.`,
                            );
                          }}
                        >
                          Set as A
                        </button>
                        <button
                          onClick={() => {
                            setCompareB(candidate);
                            setCompareBStudy(study);
                            setTab('comparison');
                          }}
                        >
                          Compare as B
                        </button>
                      </div>
                    </section>
                    <MappingEditor
                      scenario={study.scenario}
                      mapping={draft}
                      selectedChute={selectedChute}
                      onSelect={setSelectedChute}
                      onChange={setDraft}
                      onReset={() => setDraft(candidate.mapping)}
                      changed={changes.length}
                    />
                  </div>
                </div>
              )}
              {candidate && tab === 'prediction' && <PredictionPanel candidate={candidate} />}
              {tab === 'comparison' && (
                <RunComparison
                  study={study}
                  studyA={compareAStudy ?? study}
                  studyB={compareBStudy ?? study}
                  a={compareA}
                  b={compareB}
                  onA={setCompareA}
                  onB={setCompareB}
                  live={!!service?.available && source !== 'imported'}
                />
              )}
              {candidate && (
                <section className="sorting-card evaluations-card">
                  <div className="sorting-card-heading">
                    <h2>Evaluation ledger</h2>
                    <span className="sorting-muted">
                      One row per started simulation or cache reference
                    </span>
                  </div>
                  <div className="sorting-table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Evaluation</th>
                          <th>Purpose</th>
                          <th>Seed</th>
                          <th>Status</th>
                          <th>Ticks</th>
                          <th>Sorted</th>
                          <th>Reroutes</th>
                          <th>Recirculated</th>
                          <th>Seconds</th>
                        </tr>
                      </thead>
                      <tbody>
                        {candidate.evaluations.map((evaluation) => (
                          <tr key={evaluation.id}>
                            <td>{evaluation.id}</td>
                            <td>{evaluation.purpose.replaceAll('-', ' ')}</td>
                            <td>{evaluation.simulationSeed}</td>
                            <td>
                              {evaluation.cacheOf
                                ? `Cache of ${evaluation.cacheOf}`
                                : evaluation.status}
                            </td>
                            <td>{evaluation.executedTicks}</td>
                            <td>{evaluation.metrics?.sortedParcels ?? '—'}</td>
                            <td>{evaluation.metrics?.reroutes ?? '—'}</td>
                            <td>{evaluation.metrics?.recirculated ?? '—'}</td>
                            <td>{number(evaluation.wallSeconds, 3)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
              <footer className="sorting-provenance">
                <span>
                  {study.scenario.map.id} · {study.scenario.fleetSize} robots ·{' '}
                  {study.scenario.horizon} ticks
                  {study.optimizerSeed == null
                    ? ' · manual evaluation'
                    : ` · optimizer seed ${study.optimizerSeed}`}
                </span>
                <span>
                  {study.costs.completed} completed · {study.costs.cancelled} cancelled ·{' '}
                  {study.costs.replicates} repeats · {study.costs.executedTicks.toLocaleString()}{' '}
                  executed ticks
                </span>
                {study.costs.historyCalls > 0 && (
                  <span>
                    Historical data: {study.costs.historyCalls} calls /{' '}
                    {number(study.costs.historySeconds, 1)} seconds, outside the online budget.
                  </span>
                )}
                <span>
                  Simulator {study.simulator.upstreamRevision.slice(0, 8)} · patch{' '}
                  {study.simulator.patchRevision} · build {study.simulator.buildHash.slice(0, 10)}
                </span>
              </footer>
            </>
          )}
        </div>
      </main>
      <input
        hidden
        type="file"
        accept="application/json,.json"
        ref={input}
        aria-label="Import sorting study"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          const token = ++request.current;
          try {
            const record = parseStudyRecord(JSON.parse(await file.text()));
            if (token !== request.current) return;
            acceptStudy(record, 'imported');
            setNotice(
              'Imported a saved record. Its predictions and measurements have not been rerun.',
            );
            setError('');
          } catch (failure) {
            if (token === request.current)
              setError(failure instanceof Error ? failure.message : String(failure));
          }
        }}
      />
    </div>
  );
}
