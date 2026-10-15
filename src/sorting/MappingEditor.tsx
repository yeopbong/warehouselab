import { useState } from 'react';
import { mappingCounts, mappingErrors } from './mapping';
import type { SortingScenario } from './types';

export default function MappingEditor({
  scenario,
  mapping,
  selectedChute,
  onSelect,
  onChange,
  onReset,
  changed,
}: {
  scenario: SortingScenario;
  mapping: string[];
  selectedChute: number | null;
  onSelect: (index: number) => void;
  onChange: (mapping: string[]) => void;
  onReset: () => void;
  changed: number;
}) {
  const [target, setTarget] = useState('');
  const [swapTarget, setSwapTarget] = useState('');
  const [editError, setEditError] = useState('');
  const counts = mappingCounts(scenario, mapping);
  const errors = mappingErrors(scenario, mapping);
  const selected = selectedChute == null ? null : scenario.map.chutes[selectedChute];
  const commit = (next: string[]) => {
    const violations = mappingErrors(scenario, next);
    if (violations.length) {
      setEditError(violations.join(' '));
      return;
    }
    setEditError('');
    onChange(next);
  };
  return (
    <section className="sorting-card mapping-editor" aria-label="Mapping editor">
      <div className="sorting-card-heading">
        <div>
          <span className="eyebrow">Initial mapping</span>
          <h2>Make a controlled change</h2>
        </div>
        <span className={changed ? 'sorting-badge warm' : 'sorting-badge'}>
          {changed ? `${changed} unmeasured change${changed === 1 ? '' : 's'}` : 'Recorded mapping'}
        </span>
      </div>
      <p className="sorting-muted">
        Select a chute on the map or below. Transfers change chute counts within quotas; swaps
        preserve the counts. Every new evaluation starts from the initial state.
      </p>
      <label>
        Chute
        <select
          aria-label="Chute to edit"
          value={selectedChute ?? ''}
          onChange={(event) => {
            onSelect(Number(event.target.value));
            setEditError('');
          }}
        >
          <option value="" disabled>
            Select a chute
          </option>
          {scenario.map.chutes.map((chute, index) => (
            <option value={index} key={chute.id}>
              {chute.id} · {mapping[index]}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <>
          <div className="sorting-form-row">
            <label>
              Transfer to destination
              <select
                aria-label="Transfer destination"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              >
                <option value="">Choose destination</option>
                {scenario.destinations.map((destination) => (
                  <option key={destination.id} value={destination.id}>
                    {destination.label} · {counts.get(destination.id) ?? 0}/{destination.minChutes}–
                    {destination.maxChutes}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={!target || mapping[selectedChute!] === target}
              onClick={() => {
                const next = [...mapping];
                next[selectedChute!] = target;
                commit(next);
              }}
            >
              Transfer
            </button>
          </div>
          <div className="sorting-form-row">
            <label>
              Swap with chute
              <select
                aria-label="Swap chute"
                value={swapTarget}
                onChange={(event) => setSwapTarget(event.target.value)}
              >
                <option value="">Choose chute</option>
                {scenario.map.chutes.map((chute, index) =>
                  index === selectedChute ? null : (
                    <option key={chute.id} value={index}>
                      {chute.id} · {mapping[index]}
                    </option>
                  ),
                )}
              </select>
            </label>
            <button
              disabled={
                swapTarget === '' || mapping[Number(swapTarget)] === mapping[selectedChute!]
              }
              onClick={() => {
                const next = [...mapping];
                [next[selectedChute!], next[Number(swapTarget)]] = [
                  next[Number(swapTarget)],
                  next[selectedChute!],
                ];
                commit(next);
              }}
            >
              Swap
            </button>
          </div>
        </>
      )}
      {(editError || errors.length > 0) && (
        <p className="sorting-alert" role="alert">
          {editError || errors.join(' ')}
        </p>
      )}
      <div className="sorting-inline">
        <span className="sorting-muted">
          {errors.length ? 'Constraints need attention.' : 'All destination quotas satisfied.'}
        </span>
        <button
          disabled={!changed}
          onClick={() => {
            onReset();
            setEditError('');
          }}
        >
          Reset changes
        </button>
      </div>
    </section>
  );
}
