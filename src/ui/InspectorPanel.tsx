import type { Scenario } from '../core/model/types';
import type { Inspection } from '../workers/simulation-protocol';
import type { Selection } from './CanvasMap';
import { Field, NumberSetting, inventory, pct } from './fields';
export default function InspectorPanel({
  scenario,
  inspection,
  selection,
  onSelect,
  onRobotCount,
  onSeed,
  onStation,
  onMove,
  onRemove,
}: {
  scenario: Scenario;
  inspection: Inspection | null;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onRobotCount: (n: number) => void;
  onSeed: (n: number) => void;
  onStation: (
    id: string,
    key: 'inputCapacity' | 'outputCapacity' | 'supplyInterval',
    n: number,
  ) => void;
  onMove: () => void;
  onRemove: () => void;
}) {
  const robot =
    selection?.kind === 'robot' ? inspection?.robots.find((r) => r.id === selection.id) : undefined;
  const station =
    selection?.kind === 'station'
      ? inspection?.stations.find((s) => s.id === selection.id)
      : undefined;
  const recipe = scenario.recipes.find((r) => r.id === station?.recipeId);
  return (
    <div className="panel-content">
      <div className="section-heading">
        <h2>Properties</h2>
        <span className="muted mono">Snapshot {inspection?.tick ?? 0}</span>
      </div>
      <p className="snapshot-note">
        Properties show the executed snapshot tick above; the moving map may display an earlier
        tick.
      </p>
      <Field label="Inspect object">
        <select
          aria-label="Inspect object"
          value={selection && selection.kind !== 'cell' ? `${selection.kind}:${selection.id}` : ''}
          onChange={(e) => {
            const [kind, ...rest] = e.target.value.split(':');
            onSelect(kind === 'robot' || kind === 'station' ? { kind, id: rest.join(':') } : null);
          }}
        >
          <option value="">Select on map…</option>
          <optgroup label="Robots">
            {scenario.robots.map((r) => (
              <option key={r.id} value={`robot:${r.id}`}>
                {r.id}
              </option>
            ))}
          </optgroup>
          <optgroup label="Stations">
            {scenario.stations.map((s) => (
              <option key={s.id} value={`station:${s.id}`}>
                {s.id}
              </option>
            ))}
          </optgroup>
        </select>
      </Field>
      {robot ? (
        <div data-testid="robot-inspector">
          <h3>
            {robot.id} <span className="muted">{robot.status}</span>
          </h3>
          <dl className="detail-list">
            <dt>Position</dt>
            <dd>
              ({robot.position.x}, {robot.position.y})
            </dd>
            <dt>Cargo</dt>
            <dd>{robot.load ? `${robot.load.quantity} ${robot.load.item}` : 'Empty'}</dd>
            <dt>Waiting</dt>
            <dd>{robot.waitReason || 'None'}</dd>
            <dt>Wait ticks</dt>
            <dd>
              {robot.waitTicks} current / {robot.totalWaitTicks} total
            </dd>
            <dt>Service until</dt>
            <dd>Tick {robot.serviceUntil}</dd>
          </dl>
          <h3>Committed tasks ({robot.tasks.length})</h3>
          {robot.tasks.map((task, i) => (
            <div className="task-row" key={task.id}>
              <strong>
                {i ? 'Queued' : 'Current'} · {task.quantity} {task.item}
              </strong>
              <span>
                {task.source} → {task.destination}
              </span>
              <span className="muted">
                {task.phase} · tick {task.createdAt}
              </span>
            </div>
          ))}
          {!robot.tasks.length && <p className="muted">Idle or returning to parking.</p>}
          <h3>Planned route</h3>
          <p className="mono route-text">
            {robot.path.map((p) => `(${p.x},${p.y})`).join(' → ') || 'No future cells reserved.'}
          </p>
          <div className="button-row">
            <button onClick={onMove}>Move robot</button>
            <button onClick={onRemove}>Remove robot</button>
          </div>
        </div>
      ) : station ? (
        <div key={station.id} data-testid="station-inspector">
          <h3>{station.id}</h3>
          <p>
            {station.role} · {station.status}
          </p>
          <dl className="detail-list">
            <dt>Service cell</dt>
            <dd>
              ({station.service.x}, {station.service.y})
            </dd>
            <dt>Input stock</dt>
            <dd>{inventory(station.input)}</dd>
            <dt>Output stock</dt>
            <dd>{inventory(station.output)}</dd>
            <dt>Reserved input</dt>
            <dd>{station.reservedInput}</dd>
            <dt>Reserved output</dt>
            <dd>{inventory(station.reservedOutput)}</dd>
            <dt>Utilization</dt>
            <dd>{pct(inspection?.metrics.stationUtilization[station.id] ?? 0)}</dd>
            <dt>Blocked ticks</dt>
            <dd>{station.blockedTicks}</dd>
          </dl>
          {recipe && (
            <div className="recipe">
              <strong>
                {inventory(recipe.inputs)} → {recipe.output.quantity} {recipe.output.item}
              </strong>
              <span>
                {station.processing
                  ? `${station.processing.remaining} / ${recipe.duration} ticks remaining`
                  : `${recipe.duration} ticks per batch`}
              </span>
              <progress
                max={recipe.duration}
                value={station.processing ? recipe.duration - station.processing.remaining : 0}
              />
            </div>
          )}
          <h3>Edit station</h3>
          <p className="muted">Apply resets the run.</p>
          <NumberSetting
            label="Station input capacity"
            value={station.inputCapacity}
            min={1}
            onApply={(n) => onStation(station.id, 'inputCapacity', n)}
          />
          <NumberSetting
            label="Station output capacity"
            value={station.outputCapacity}
            min={1}
            onApply={(n) => onStation(station.id, 'outputCapacity', n)}
          />
          {station.role === 'supply' && (
            <NumberSetting
              label="Supply interval"
              value={station.supplyInterval ?? 1}
              min={1}
              onApply={(n) => onStation(station.id, 'supplyInterval', n)}
            />
          )}
          <div className="button-row">
            <button onClick={onMove}>Move station</button>
            <button onClick={onRemove}>Remove station</button>
          </div>
          <h3>Station task queue</h3>
          {inspection?.robots.flatMap((r) =>
            r.tasks
              .filter((t) => t.source === station.id || t.destination === station.id)
              .map((t) => (
                <div className="task-row" key={t.id}>
                  <strong>
                    {r.id} · {t.quantity} {t.item}
                  </strong>
                  <span>
                    {t.source} → {t.destination}
                  </span>
                </div>
              )),
          )}
        </div>
      ) : (
        <div className="empty-inspector">
          <h3>
            {selection?.kind === 'cell'
              ? `Cell ${selection.position.x}, ${selection.position.y}`
              : 'Select a robot or machine'}
          </h3>
          <p>
            Inspect cargo, reservations, processing and waiting. Drag with the wall or erase tool to
            edit the initial layout.
          </p>
        </div>
      )}
      <hr />
      <h3>Factory settings</h3>
      <NumberSetting
        label="Robot count"
        value={scenario.robots.length}
        max={24}
        onApply={onRobotCount}
      />
      <NumberSetting
        label="Scenario seed"
        value={scenario.seed}
        max={4294967295}
        onApply={onSeed}
      />
      <p className="muted">{scenario.description}</p>
    </div>
  );
}
