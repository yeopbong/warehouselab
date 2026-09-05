import { useEffect, useState } from 'react';
import type { PolicyConfig } from '../core/model/types';
import { BASELINE, QUEUE_AWARE, normalizeConfig } from '../core/policies/config';
import { Field, numberValue } from './fields';
export default function PolicyPanel({
  config,
  onApply,
}: {
  config: PolicyConfig;
  onApply: (config: PolicyConfig) => void;
}) {
  const draftOf = (c: PolicyConfig) => ({
    ...c,
    congestionWeight: String(c.congestionWeight),
    planningWindow: String(c.planningWindow),
    replanInterval: String(c.replanInterval),
  });
  const [draft, setDraft] = useState(() => draftOf(config));
  const [error, setError] = useState('');
  useEffect(() => {
    setDraft(draftOf(config));
    setError('');
  }, [config]);
  const apply = () => {
    try {
      onApply(
        normalizeConfig({
          ...draft,
          congestionWeight: numberValue(draft.congestionWeight, 'Congestion weight', 0, 5, false),
          planningWindow: numberValue(draft.planningWindow, 'Planning window', 4, 32),
          replanInterval: numberValue(draft.replanInterval, 'Replan interval', 1, 8),
        }),
      );
      setError('');
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <div className="panel-content">
      <h2>Dispatch & traffic</h2>
      <p className="muted">Apply changes to restart from the initial layout.</p>
      <div className="button-row">
        <button onClick={() => onApply({ ...BASELINE })}>Baseline</button>
        <button onClick={() => onApply({ ...QUEUE_AWARE })}>Queue aware</button>
      </div>
      <Field label="Task assignment">
        <select
          aria-label="Task assignment"
          value={draft.assignment}
          onChange={(e) =>
            setDraft({ ...draft, assignment: e.target.value as PolicyConfig['assignment'] })
          }
        >
          <option value="nearest">Nearest idle robot</option>
          <option value="earliest">Earliest finish + queue</option>
        </select>
      </Field>
      <Field label="Robot traffic priority">
        <select
          aria-label="Traffic priority"
          value={draft.priority}
          onChange={(e) =>
            setDraft({ ...draft, priority: e.target.value as PolicyConfig['priority'] })
          }
        >
          <option value="fixed">Fixed robot ID</option>
          <option value="waiting">Longest waiting robot</option>
        </select>
      </Field>
      <Field label="Route cost">
        <select
          aria-label="Route cost"
          value={draft.routing}
          onChange={(e) =>
            setDraft({ ...draft, routing: e.target.value as PolicyConfig['routing'] })
          }
        >
          <option value="distance">Distance</option>
          <option value="congestion">Distance + congestion</option>
        </select>
      </Field>
      {(['congestionWeight', 'planningWindow', 'replanInterval'] as const).map((key, index) => (
        <Field key={key} label={['Congestion weight', 'Planning window', 'Replan interval'][index]}>
          <input
            type="number"
            aria-label={['Congestion weight', 'Planning window', 'Replan interval'][index]}
            value={draft[key]}
            disabled={key === 'congestionWeight' && draft.routing === 'distance'}
            onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') apply();
            }}
          />
        </Field>
      ))}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <button className="primary full-width" onClick={apply}>
        Apply policy & reset
      </button>
      <h3>Order priority</h3>
      <p>
        Executable deliveries serve the oldest arrived order across all stations. Order ID breaks
        equal-age ties.
      </p>
      <p className="muted">
        Robot traffic priority changes who plans first. It does not change the order backlog
        priority.
      </p>
    </div>
  );
}
