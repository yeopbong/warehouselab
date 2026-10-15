import { useEffect, useMemo, useState } from 'react';
import { getTrace } from './client';
import SortingMap, { type MapRobot } from './SortingMap';
import type { Candidate, Evaluation, RunTrace, Study, TraceEvent } from './types';

function useTrace(evaluation: Evaluation | undefined, live: boolean) {
  const [trace, setTrace] = useState<RunTrace | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setTrace(null);
    setError('');
    if (!evaluation?.traceUrl || evaluation.status !== 'completed') {
      setLoading(false);
      return;
    }
    setLoading(true);
    getTrace<RunTrace>(evaluation.id, evaluation.traceUrl, live)
      .then((record) => {
        if (
          !Array.isArray(record.positions) ||
          !record.positions.length ||
          !Array.isArray(record.events)
        )
          throw new Error('This run does not contain recorded positions and business events.');
        if (alive) setTrace(record);
      })
      .catch((failure) => {
        if (alive) setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [evaluation?.id, evaluation?.traceUrl, live]);
  return { trace, loading, error };
}

function atTick(trace: RunTrace, tick: number): [number, number, number, number] {
  let low = 0,
    high = trace.curve.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (trace.curve[mid][0] <= tick) low = mid + 1;
    else high = mid;
  }
  return trace.curve[Math.max(0, low - 1)] ?? [0, 0, 0, 0];
}

function destinationId(event: TraceEvent | undefined, study: Study, trace: RunTrace): string {
  return event?.destination == null
    ? ''
    : (trace.destinationIds?.[event.destination] ??
        study.scenario.destinations[event.destination]?.id ??
        '');
}

function eventText(event: TraceEvent, study: Study, trace: RunTrace): string {
  const destination =
    study.scenario.destinations.find((value) => value.id === destinationId(event, study, trace))
      ?.label ?? '';
  const chute = study.scenario.map.chutes.find((value) => value.cell === event.chute)?.id;
  if (event.type === 'close' || event.type === 'open')
    return `${chute ?? event.chute} ${event.type === 'close' ? 'closed' : 'reopened'}`;
  const parcel = event.parcel != null && event.parcel >= 0 ? `Parcel ${event.parcel} · ` : '';
  return `${parcel}${event.type} · robot ${event.robot ?? '—'}${destination ? ` · ${destination}` : ''}${chute ? ` → ${chute}` : ''}`;
}

function TracePane({
  side,
  study,
  candidate,
  onCandidate,
  evaluationId,
  onEvaluation,
  evaluation,
  trace,
  loading,
  error,
  tick,
  onTick,
}: {
  side: string;
  study: Study;
  candidate: Candidate | null;
  onCandidate: (candidate: Candidate) => void;
  evaluationId: string;
  onEvaluation: (id: string) => void;
  evaluation: Evaluation | undefined;
  trace: RunTrace | null;
  loading: boolean;
  error: string;
  tick: number;
  onTick: (tick: number) => void;
}) {
  const [robotId, setRobotId] = useState<string | number | null>(null);
  const [parcelId, setParcelId] = useState('');
  const [eventType, setEventType] = useState('operational');
  const [chuteIndex, setChuteIndex] = useState<number | null>(null);
  const frameTick = trace ? Math.min(tick, trace.positions.length - 1) : 0;
  const goals = useMemo(() => {
    const result = new Map<number, TraceEvent>();
    for (const event of trace?.events ?? []) {
      if (event.tick > frameTick) break;
      if (event.robot != null && ['assign', 'pickup', 'reroute'].includes(event.type))
        result.set(event.robot, event);
    }
    return result;
  }, [trace, frameTick]);
  const robots: MapRobot[] =
    trace?.positions[frameTick]?.map((cell, id) => ({
      id,
      cell,
      goal: goals.get(id)?.goal,
      packageId: goals.get(id)?.parcel,
    })) ?? [];
  const selected = robotId == null ? null : goals.get(Number(robotId));
  const closed = useMemo(() => {
    const cells = new Set<number>();
    for (const event of trace?.events ?? []) {
      if (event.tick > frameTick) break;
      if (event.chute == null) continue;
      if (event.type === 'close') cells.add(event.chute);
      if (event.type === 'open') cells.delete(event.chute);
    }
    return [...cells]
      .map((cell) => study.scenario.map.chutes.findIndex((chute) => chute.cell === cell))
      .filter((index) => index >= 0);
  }, [trace, frameTick, study.scenario.map]);
  const events = (trace?.events ?? []).filter((event) => {
    if (parcelId && event.parcel !== Number(parcelId)) return false;
    if (eventType === 'operational')
      return ['close', 'open', 'reroute', 'recirculate'].includes(event.type);
    return eventType === 'all' || event.type === eventType;
  });
  const nearby = events
    .filter((event) => event.tick <= frameTick)
    .slice(-50)
    .reverse();
  const totals = trace ? atTick(trace, frameTick) : null;
  return (
    <section className="sorting-card trace-pane" aria-label={`Run ${side}`}>
      <div className="sorting-card-heading">
        <h2>
          <span className={`trace-letter side-${side.toLowerCase()}`}>{side}</span> Recorded
          execution
        </h2>
        <span className="sorting-muted">{trace ? `tick ${frameTick}` : 'No replay loaded'}</span>
      </div>
      <p className="sorting-muted trace-condition">
        {study.scenario.name} · {study.method} · {study.id}
      </p>
      <div className="sorting-form-row">
        <label>
          Candidate {side}
          <select
            aria-label={`Run ${side} candidate`}
            value={candidate?.id ?? ''}
            onChange={(event) => {
              const next = study.candidates.find((value) => value.id === event.target.value);
              if (next) onCandidate(next);
            }}
          >
            <option value="" disabled>
              Select candidate
            </option>
            {study.candidates.map((value) => (
              <option key={value.id} value={value.id}>
                {value.id} · {value.operation}
              </option>
            ))}
          </select>
        </label>
        <label>
          Evaluation
          <select
            aria-label={`Run ${side} evaluation`}
            value={evaluation?.id ?? evaluationId}
            onChange={(event) => onEvaluation(event.target.value)}
          >
            {candidate?.evaluations
              .filter((value) => value.status === 'completed')
              .map((value) => (
                <option value={value.id} key={value.id}>
                  Seed {value.simulationSeed} · {value.executedTicks} ticks
                  {!value.traceUrl ? ' · no trace' : ''}
                </option>
              ))}
          </select>
        </label>
      </div>
      {error && <p className="sorting-alert">{error}</p>}
      {loading ? (
        <div className="sorting-empty compact">Loading recorded positions and events…</div>
      ) : trace && candidate ? (
        <>
          <SortingMap
            scenario={study.scenario}
            mapping={candidate.mapping}
            selectedDestination={destinationId(selected ?? undefined, study, trace)}
            selectedChute={chuteIndex}
            changed={candidate.changedChutes}
            robots={robots}
            closedChutes={closed}
            selectedRobot={robotId}
            onRobot={setRobotId}
            onChute={setChuteIndex}
            label={`Run ${side} recorded positions at tick ${frameTick}`}
          />
          <div className="trace-totals">
            <span>
              Sorted <strong>{totals?.[1] ?? 0}</strong>
            </span>
            <span>
              Recirculated <strong>{totals?.[2] ?? 0}</strong>
            </span>
            <span>
              Reroutes <strong>{totals?.[3] ?? 0}</strong>
            </span>
            <span>
              Closed <strong data-testid="closed-chute-count">{closed.length}</strong>
            </span>
          </div>
          <div className="trace-selection">
            <label>
              Inspect robot
              <select
                aria-label={`Run ${side} robot`}
                value={robotId ?? ''}
                onChange={(event) => setRobotId(Number(event.target.value))}
              >
                <option value="" disabled>
                  Select robot
                </option>
                {robots.map((robot) => (
                  <option value={robot.id} key={robot.id}>
                    Robot {robot.id}
                  </option>
                ))}
              </select>
            </label>
            <p className="sorting-muted">
              {selected
                ? `Parcel ${selected.parcel != null && selected.parcel >= 0 ? selected.parcel : 'none'} · target cell ${selected.goal ?? 'none'}. Dashed line marks the target, not a planned route.`
                : 'Select a robot to see its recorded target and parcel identity.'}
            </p>
          </div>
          <div className="sorting-form-row">
            <label>
              Business events
              <select
                aria-label={`Run ${side} events`}
                value={eventType}
                onChange={(event) => setEventType(event.target.value)}
              >
                <option value="operational">Closures, reroutes & recirculation</option>
                <option value="all">All business events</option>
                <option value="close">Chute closures</option>
                <option value="reroute">Reroutes</option>
                <option value="recirculate">Recirculation</option>
                <option value="dropoff">Sorted deliveries</option>
                <option value="pickup">Parcel pickups</option>
              </select>
            </label>
            <label>
              Parcel ID
              <input
                aria-label={`Run ${side} parcel ID`}
                inputMode="numeric"
                value={parcelId}
                placeholder="All parcels"
                onChange={(event) => setParcelId(event.target.value.replace(/\D/g, ''))}
              />
            </label>
          </div>
          <div className="trace-events" data-testid={`trace-events-${side.toLowerCase()}`}>
            {nearby.length ? (
              nearby.map((event, index) => (
                <button
                  key={`${event.tick}-${index}`}
                  onClick={() => {
                    onTick(event.tick);
                    if (event.robot != null) setRobotId(event.robot);
                    if (event.chute != null)
                      setChuteIndex(
                        study.scenario.map.chutes.findIndex((chute) => chute.cell === event.chute),
                      );
                  }}
                >
                  <time>{event.tick}</time>
                  <span>{eventText(event, study, trace)}</span>
                </button>
              ))
            ) : (
              <p className="sorting-muted">No matching events at or before this tick.</p>
            )}
          </div>
          <p className="sorting-muted">
            Latest 50 matching events through this tick; {events.length} in the full run. Parcel IDs
            persist through reroutes and recirculation.
          </p>
        </>
      ) : (
        <div className="sorting-empty compact">
          No saved business replay for this evaluation. The map preview is not a simulation. Run a
          real evaluation locally to record a new trace.
        </div>
      )}
    </section>
  );
}

export default function RunComparison({
  study,
  studyA = study,
  studyB = study,
  a,
  b,
  onA,
  onB,
  live,
}: {
  study: Study;
  studyA?: Study;
  studyB?: Study;
  a: Candidate | null;
  b: Candidate | null;
  onA: (candidate: Candidate) => void;
  onB: (candidate: Candidate) => void;
  live: boolean;
}) {
  const [evaluationAId, setEvaluationAId] = useState('');
  const [evaluationBId, setEvaluationBId] = useState('');
  const evaluationA =
    a?.evaluations.find((value) => value.id === evaluationAId) ??
    a?.evaluations.find((value) => value.status === 'completed' && value.traceUrl) ??
    a?.evaluations.find((value) => value.status === 'completed');
  const evaluationB =
    b?.evaluations.find((value) => value.id === evaluationBId) ??
    b?.evaluations.find((value) => value.status === 'completed' && value.traceUrl) ??
    b?.evaluations.find((value) => value.status === 'completed');
  const first = useTrace(evaluationA, live),
    second = useTrace(evaluationB, live);
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [metric, setMetric] = useState<'sorted' | 'recirculation' | 'reroutes'>('sorted');
  const maxTick = Math.max(
    0,
    (first.trace?.positions.length ?? 1) - 1,
    (second.trace?.positions.length ?? 1) - 1,
  );
  useEffect(() => {
    setTick(0);
    setPlaying(false);
  }, [evaluationA?.id, evaluationB?.id]);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(
      () =>
        setTick((previous) => {
          if (previous >= maxTick) {
            setPlaying(false);
            return maxTick;
          }
          return Math.min(maxTick, previous + 10);
        }),
      100,
    );
    return () => clearInterval(timer);
  }, [playing, maxTick]);
  const traces = [first.trace, second.trace];
  const index = metric === 'sorted' ? 1 : metric === 'recirculation' ? 2 : 3;
  const maxValue = Math.max(1, ...traces.map((trace) => trace?.curve.at(-1)?.[index] ?? 0));
  const width = 800,
    height = 140,
    left = 45,
    right = 20,
    top = 14,
    bottom = 28;
  const y = (value: number) => top + (1 - value / maxValue) * (height - top - bottom);
  const x = (value: number) => left + (value / Math.max(1, maxTick)) * (width - left - right);
  return (
    <div className="run-comparison">
      <section className="sorting-card replay-controls">
        <div className="sorting-card-heading">
          <div>
            <span className="eyebrow">Independent runs from the initial state</span>
            <h2>Compare when behavior diverges</h2>
          </div>
          <label>
            Accumulated measure
            <select
              aria-label="Replay curve measure"
              value={metric}
              onChange={(event) => setMetric(event.target.value as typeof metric)}
            >
              <option value="sorted">Sorted parcels</option>
              <option value="recirculation">Recirculated parcels</option>
              <option value="reroutes">Reroutes</option>
            </select>
          </label>
        </div>
        <p className="sorting-muted">
          {study.scenario.randomization ??
            'Different mappings can consume random inputs differently. Equal seed labels do not guarantee paired external demand.'}{' '}
          Positions and business events below are recorded observations.
        </p>
        {studyA.scenario.id !== studyB.scenario.id && (
          <p className="sorting-note">
            These runs use different demand or fleet conditions. Their difference is not an estimate
            of the mapping change alone.
          </p>
        )}
        {studyA.scenario.horizon !== studyB.scenario.horizon && (
          <p className="sorting-note">
            Run horizons differ. Each replay stops at its own last recorded tick.
          </p>
        )}
        {(first.trace || second.trace) && (
          <svg
            className="replay-curve"
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`Recorded cumulative ${metric}`}
          >
            <line x1={left} x2={width - right} y1={y(0)} y2={y(0)} className="curve-grid" />
            <text x={left - 8} y={y(0) + 3} textAnchor="end">
              0
            </text>
            <text x={left - 8} y={y(maxValue) + 4} textAnchor="end">
              {maxValue}
            </text>
            {traces.map(
              (trace, side) =>
                trace && (
                  <polyline
                    key={side}
                    className={`replay-line side-${side === 0 ? 'a' : 'b'}`}
                    points={trace.curve
                      .filter(
                        (_, position) =>
                          position % Math.max(1, Math.floor(trace.curve.length / 900)) === 0 ||
                          position === trace.curve.length - 1,
                      )
                      .map((point) => `${x(point[0])},${y(point[index])}`)
                      .join(' ')}
                  />
                ),
            )}
            <line
              x1={x(tick)}
              x2={x(tick)}
              y1={top}
              y2={height - bottom}
              className="replay-cursor"
            />
            <text x={left} y={height - 5}>
              Tick 0
            </text>
            <text x={width - right} y={height - 5} textAnchor="end">
              {maxTick}
            </text>
          </svg>
        )}
        <div className="sorting-timeline">
          <button
            className="sorting-primary"
            disabled={!maxTick}
            onClick={() => setPlaying(!playing)}
          >
            {playing ? 'Pause replay' : 'Play replay'}
          </button>
          <input
            aria-label="Comparison replay tick"
            type="range"
            min="0"
            max={maxTick}
            value={Math.min(tick, maxTick)}
            disabled={!maxTick}
            onChange={(event) => {
              setPlaying(false);
              setTick(Number(event.target.value));
            }}
          />
          <label>
            Tick
            <input
              aria-label="Comparison tick"
              type="number"
              min="0"
              max={maxTick}
              value={Math.min(tick, maxTick)}
              disabled={!maxTick}
              onChange={(event) => {
                setPlaying(false);
                setTick(Math.max(0, Math.min(maxTick, Number(event.target.value) || 0)));
              }}
            />
          </label>
        </div>
      </section>
      <div className="trace-pair">
        <TracePane
          side="A"
          study={studyA}
          candidate={a}
          onCandidate={onA}
          evaluationId={evaluationAId}
          onEvaluation={setEvaluationAId}
          evaluation={evaluationA}
          {...first}
          tick={tick}
          onTick={setTick}
        />
        <TracePane
          side="B"
          study={studyB}
          candidate={b}
          onCandidate={onB}
          evaluationId={evaluationBId}
          onEvaluation={setEvaluationBId}
          evaluation={evaluationB}
          {...second}
          tick={tick}
          onTick={setTick}
        />
      </div>
    </div>
  );
}
