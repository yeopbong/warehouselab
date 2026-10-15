import { useState } from 'react';
import type { Candidate, ZoneMetrics } from './types';

export default function PredictionPanel({ candidate }: { candidate: Candidate }) {
  const [field, setField] = useState<keyof ZoneMetrics>('trafficWaitFraction');
  const [mode, setMode] = useState<'predicted' | 'measured' | 'residual'>('residual');
  const runs = candidate.evaluations.filter(
    (evaluation) => evaluation.status === 'completed' && evaluation.auxiliary?.zones.length,
  );
  const predicted = candidate.prediction?.auxiliary?.zones;
  const measured = runs.length
    ? Array.from(
        { length: 12 },
        (_, index) =>
          runs.reduce((sum, run) => sum + (run.auxiliary?.zones[index]?.[field] ?? 0), 0) /
          runs.length,
      )
    : null;
  const available =
    mode === 'predicted'
      ? !!predicted?.length
      : mode === 'measured'
        ? !!measured
        : !!predicted?.length && !!measured;
  const values = Array.from({ length: 12 }, (_, index) =>
    mode === 'predicted'
      ? (predicted?.[index]?.[field] ?? 0)
      : mode === 'measured'
        ? (measured?.[index] ?? 0)
        : (measured?.[index] ?? 0) - (predicted?.[index]?.[field] ?? 0),
  );
  const scale = Math.max(0.01, ...values.map(Math.abs));
  return (
    <section className="sorting-card forecast-panel" aria-label="Operational predictions">
      <div className="sorting-card-heading">
        <div>
          <span className="eyebrow">Operational signals</span>
          <h2>Where the prediction misses</h2>
        </div>
      </div>
      <div className="sorting-form-row">
        <label>
          Signal
          <select
            value={field}
            onChange={(event) => setField(event.target.value as keyof ZoneMetrics)}
            aria-label="Operational signal"
          >
            <option value="trafficWaitFraction">Traffic waiting fraction</option>
            <option value="closedFraction">Chute closed fraction</option>
          </select>
        </label>
        <label>
          View
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as typeof mode)}
            aria-label="Distribution view"
          >
            <option value="residual">Measured − predicted</option>
            <option value="predicted">Predicted</option>
            <option value="measured">Measured</option>
          </select>
        </label>
      </div>
      {available ? (
        <div className="zone-grid" data-testid="zone-distribution">
          {values.map((value, index) => (
            <div
              key={index}
              className="zone-cell"
              style={{
                backgroundColor:
                  mode === 'residual' && value < 0
                    ? `rgba(51, 125, 150, ${0.08 + (Math.abs(value) / scale) * 0.52})`
                    : `rgba(174, 101, 61, ${0.08 + (Math.abs(value) / scale) * 0.52})`,
              }}
            >
              <span>Zone {index + 1}</span>
              <strong>
                {value > 0 && mode === 'residual' ? '+' : ''}
                {(value * 100).toFixed(1)}
                <small>{mode === 'residual' ? ' pp' : '%'}</small>
              </strong>
            </div>
          ))}
        </div>
      ) : (
        <div className="sorting-empty compact">
          {mode === 'residual'
            ? 'A saved pre-evaluation prediction and completed measurement are both needed.'
            : mode === 'predicted'
              ? 'No model prediction was recorded for this candidate.'
              : 'No completed operational measurements yet.'}
        </div>
      )}
      <p className="sorting-muted">
        3 rows × 4 columns, left to right and top to bottom.{' '}
        {field === 'trafficWaitFraction'
          ? 'Traffic waiting counts stopped robots away from a goal, excluding service waits, divided by all robot-ticks.'
          : 'Closure is closed chute-ticks divided by the zone’s chute-ticks.'}{' '}
        {mode === 'residual'
          ? 'Residuals are percentage points, not causal effects.'
          : 'Fractions are displayed as percentages.'}{' '}
        {runs.length > 1 ? `Measured values average ${runs.length} runs.` : ''}
      </p>
      {candidate.prediction && (
        <p className="sorting-muted">
          Prediction frozen before evaluation
          {candidate.prediction.trainedThrough != null
            ? ` · trained through ${candidate.prediction.trainedThrough} evaluations`
            : ''}
          {candidate.prediction.modelId ? ` · ${candidate.prediction.modelId}` : ''}.
        </p>
      )}
    </section>
  );
}
