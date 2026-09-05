import { useEffect, useMemo, useRef, useState } from 'react';
import type { PolicyConfig, Scenario } from '../core/model/types';
import { KERNEL_VERSION } from '../core/model/types';
import { BASELINE, normalizeConfig } from '../core/policies/config';
import { parseBundle, validateScenario } from '../core/model/validation';
import { contentHash } from '../core/model/random';
import type { SearchProgress, SearchResult } from '../core/optimization/search';
import type { FrozenEvaluation } from '../core/optimization/evaluation';
import type {
  SearchCommand,
  SearchResponse,
  RequestIdentity,
  ComparisonResult,
  ComparisonProgress,
} from '../workers/search-protocol';
import { PRESETS } from '../scenarios';
import { CODE_VERSION } from '../version';
import CanvasMap, { type Selection, type Tool, type EditAction } from './CanvasMap';
import { useSimulation } from './useSimulation';
import { applyEdit, previewEdit, withRobotCount, HISTORY_LIMIT } from './editor';
import InspectorPanel from './InspectorPanel';
import PolicyPanel from './PolicyPanel';
import OptimizePanel, { type SearchSettings } from './OptimizePanel';
import { Icon, fixed, pct, numberValue } from './fields';
const STORAGE_KEY = 'warehouselab.scenario.v1';
const TOOLS: [Tool, string][] = [
  ['select', 'Select'],
  ['pan', 'Pan'],
  ['move', 'Move'],
  ['obstacle', 'Wall'],
  ['erase', 'Erase'],
  ['supply', 'Supply'],
  ['process', 'Process'],
  ['assembly', 'Assembly'],
  ['delivery', 'Delivery'],
  ['robot', 'Robot'],
];
function download(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function App() {
  const [scenario, setScenario] = useState<Scenario>(() => structuredClone(PRESETS[0]));
  const [config, setConfig] = useState<PolicyConfig>({ ...BASELINE });
  const sim = useSimulation(scenario, config);
  const [selection, setSelection] = useState<Selection>(null),
    [tool, setTool] = useState<Tool>('select');
  const [editing, setEditing] = useState(false),
    [fitSignal, setFitSignal] = useState(0);
  const [showPaths, setShowPaths] = useState(false),
    [heatmap, setHeatmap] = useState(false);
  const [panel, setPanel] = useState<'inspect' | 'policy' | 'search'>('inspect');
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth >= 760);
  const [notice, setNotice] = useState('Ready. Start the factory or choose a tool to edit.'),
    [error, setError] = useState('');
  const [replay, setReplay] = useState('0'),
    [drawer, setDrawer] = useState<'orders' | 'logs' | 'about' | null>(null);
  const [displayTick, setDisplayTick] = useState(0);
  const [historyCount, setHistoryCount] = useState({ past: 0, future: 0 });
  const history = useRef<{ past: Scenario[]; future: Scenario[] }>({ past: [], future: [] });
  const seekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const replayIntent = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null),
    candidateInput = useRef<HTMLInputElement>(null);
  const importSequence = useRef({ scene: 0, candidate: 0 });
  const [active, setActive] = useState<'search' | 'compare' | null>(null);
  const [progress, setProgress] = useState<SearchProgress | null>(null),
    [result, setResult] = useState<SearchResult | null>(null);
  const [candidate, setCandidate] = useState<PolicyConfig | null>(null),
    [candidateTraining, setCandidateTraining] = useState<FrozenEvaluation | null>(null);
  const [comparison, setComparison] = useState<ComparisonResult | null>(null),
    [compareProgress, setCompareProgress] = useState<ComparisonProgress | null>(null);
  const optimizer = useRef<Worker | null>(null),
    activeRequest = useRef<RequestIdentity | null>(null),
    searchSequence = useRef(0);
  const [archived, setArchived] = useState<(SearchResult | ComparisonResult)[]>([]);
  const previousSearch = useRef<SearchResult | null>(null);
  const archive = (value: SearchResult | ComparisonResult) =>
    setArchived((old) => [...old.slice(-2), value]);
  const scenarioHash = useMemo(() => contentHash(scenario), [scenario]);
  const tick = sim.inspection?.tick ?? 0,
    maxTick = sim.inspection?.maxTick ?? 0,
    metric = sim.inspection?.metrics;
  useEffect(() => {
    const worker = new Worker(new URL('../workers/search.worker.ts', import.meta.url), {
      type: 'module',
    });
    optimizer.current = worker;
    worker.onmessage = (event: MessageEvent<SearchResponse>) => {
      const m = event.data,
        current = activeRequest.current;
      if (m.type === 'retired-result' || m.type === 'retired-comparison') {
        archive(m.type === 'retired-result' ? m.result : m.comparison);
        return;
      }
      if (
        !current ||
        m.requestId !== current.requestId ||
        m.revision !== current.revision ||
        m.revision !== sim.revisionRef.current
      ) {
        if (m.type === 'result' || m.type === 'comparison') {
          archive(m.type === 'result' ? m.result : m.comparison);
        }
        return;
      }
      if (m.type === 'progress') setProgress(m.progress);
      if (m.type === 'comparison-progress') setCompareProgress(m.progress);
      if (m.type === 'result') {
        if (previousSearch.current) archive(previousSearch.current);
        previousSearch.current = m.result;
        setResult(m.result);
        setProgress(m.result);
        setActive(null);
        activeRequest.current = null;
        if (m.result.best) {
          setCandidate(m.result.best.config);
          setCandidateTraining(m.result.evaluation);
        }
        setNotice(
          `Search ${m.result.status}. ${m.result.counters.simulations} actual simulation calls.`,
        );
        if (m.result.error) setError(m.result.error);
      }
      if (m.type === 'comparison') {
        setComparison(m.comparison);
        setActive(null);
        activeRequest.current = null;
        setNotice(
          `Comparison ${m.comparison.status}. Both policies used the same factory, seed and horizon.`,
        );
        if (m.comparison.error) setError(m.comparison.error);
      }
      if (m.type === 'error') {
        setError(m.error);
        setActive(null);
        activeRequest.current = null;
      }
    };
    worker.onerror = (e) => {
      setError(e.message);
      setActive(null);
      activeRequest.current = null;
    };
    return () => {
      worker.terminate();
      optimizer.current = null;
    };
  }, []);
  useEffect(() => {
    if (sim.error) setError(sim.error);
  }, [sim.error]);
  useEffect(() => {
    if (!replayIntent.current) setReplay(String(tick));
  }, [tick]);
  useEffect(() => () => clearTimeout(seekTimer.current), []);
  function cancelActive(reason = 'Cancelling at the next tick boundary…') {
    if (activeRequest.current)
      optimizer.current?.postMessage({
        ...activeRequest.current,
        type: 'cancel',
      } satisfies SearchCommand);
    setNotice(reason);
  }
  function invalidateActive() {
    if (activeRequest.current) {
      cancelActive('Previous calculation cancelled after the factory changed.');
      activeRequest.current = null;
      setActive(null);
    }
  }
  function reset(
    nextScene = scenario,
    nextConfig = config,
    message = 'Reset to the same initial state.',
  ) {
    const validated = validateScenario(nextScene),
      normalized = normalizeConfig(nextConfig);
    importSequence.current.scene++;
    importSequence.current.candidate++;
    invalidateActive();
    clearTimeout(seekTimer.current);
    setScenario(validated);
    setConfig(normalized);
    sim.reset(validated, normalized);
    replayIntent.current = false;
    setReplay('0');
    setDisplayTick(0);
    setComparison(null);
    setError('');
    setNotice(message);
  }
  function commitScene(
    next: Scenario,
    message = 'Scene updated. Editing the initial layout at tick 0.',
  ) {
    const validated = validateScenario(next);
    if (contentHash(validated) === scenarioHash) return;
    history.current.past.push(scenario);
    if (history.current.past.length > HISTORY_LIMIT) history.current.past.shift();
    history.current.future = [];
    setHistoryCount({ past: history.current.past.length, future: 0 });
    setEditing(true);
    reset(validated, config, message);
  }
  function edit(action: EditAction) {
    try {
      commitScene(applyEdit(scenario, action));
    } catch (e) {
      setError(String(e));
    }
  }
  function chooseTool(next: Tool) {
    clearTimeout(seekTimer.current);
    setTool(next);
    if (!['select', 'pan'].includes(next)) {
      if (!editing || tick !== 0 || sim.playing || sim.busy)
        reset(scenario, config, 'Editing initial layout. Each gesture is one undo step.');
      setEditing(true);
    }
    setNotice(
      ['select', 'pan'].includes(next)
        ? 'Select an object. Scroll to zoom; Space + drag to pan.'
        : 'Editing initial layout. Finish a stroke or move to apply it.',
    );
  }
  function undo(redo = false) {
    const from = redo ? history.current.future : history.current.past,
      to = redo ? history.current.past : history.current.future;
    const next = from.pop();
    if (!next) return;
    to.push(scenario);
    if (to.length > HISTORY_LIMIT) to.shift();
    setHistoryCount({ past: history.current.past.length, future: history.current.future.length });
    setEditing(true);
    reset(next, config, redo ? 'Edit redone.' : 'Edit undone.');
  }
  function loadScene(next: Scenario, nextConfig = config, message = 'Factory loaded.') {
    history.current = { past: [], future: [] };
    setHistoryCount({ past: 0, future: 0 });
    setSelection(null);
    setTool('select');
    setEditing(false);
    setFitSignal((n) => n + 1);
    reset(next, nextConfig, message);
  }
  function bundle() {
    return { schemaVersion: 1, scenario, config, codeVersion: CODE_VERSION };
  }
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(bundle()));
      setNotice('Factory saved locally.');
    } catch (e) {
      setError(String(e));
    }
  }
  function restore() {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (!data) throw new Error('No saved factory.');
      const parsed = parseBundle(JSON.parse(data));
      loadScene(parsed.scenario, parsed.config, 'Saved factory restored.');
    } catch (e) {
      setError(String(e));
    }
  }
  async function importFile(file: File | undefined, isCandidate = false) {
    if (!file) return;
    const kind = isCandidate ? 'candidate' : 'scene';
    const sequence = ++importSequence.current[kind];
    const revision = sim.revisionRef.current;
    const current = () =>
      sequence === importSequence.current[kind] && revision === sim.revisionRef.current;
    try {
      const value = JSON.parse(await file.text());
      if (!current()) return;
      if (isCandidate) {
        const imported = normalizeConfig(value.best?.config ?? value.config ?? value);
        invalidateActive();
        setCandidate(imported);
        setCandidateTraining(null);
        setComparison(null);
        setNotice('Candidate imported. Apply it or compare on the current factory.');
      } else {
        const parsed = parseBundle(value);
        loadScene(parsed.scenario, parsed.config, 'Scene and policy imported and validated.');
      }
    } catch (e) {
      if (current()) setError(`Import rejected: ${String(e)}`);
    }
  }
  function newScene() {
    loadScene({
      ...structuredClone(PRESETS[0]),
      id: 'custom-factory',
      name: 'Untitled factory',
      description: 'Your custom factory.',
      obstacles: [],
      stations: [],
      robots: [],
      orders: [],
      orderStream: undefined,
    });
    setEditing(true);
  }
  function playback() {
    clearTimeout(seekTimer.current);
    if (sim.playing || sim.busy) {
      sim.send({ type: 'pause' });
      setNotice('Pausing at an executed tick…');
    } else {
      setEditing(false);
      setTool('select');
      sim.send({ type: 'play', speed: sim.speed });
      setNotice(
        sim.speed > 8
          ? 'Accelerated playback: real executed states are sampled.'
          : 'Running. Select a robot or station to inspect.',
      );
    }
  }
  function seek(value: string) {
    try {
      const target = numberValue(value, 'Replay tick', 0, maxTick);
      replayIntent.current = false;
      clearTimeout(seekTimer.current);
      sim.send({ type: 'seek', tick: target });
      setEditing(false);
      setTool('select');
      setNotice(`Seeking to tick ${target}…`);
    } catch (e) {
      setError(String(e));
    }
  }
  function search(settings: SearchSettings) {
    importSequence.current.candidate++;
    const request = {
      requestId: `search-${++searchSequence.current}`,
      revision: sim.revisionRef.current,
    };
    activeRequest.current = request;
    setActive('search');
    setProgress(null);
    setCompareProgress(null);
    setError('');
    optimizer.current?.postMessage({
      ...request,
      type: 'search',
      method: settings.method,
      budget: settings.budget,
      optimizerSeed: settings.optimizerSeed,
      populationSize: 3,
      evaluation: {
        scope: settings.scope,
        scenarios:
          settings.scope === 'current-factory'
            ? [structuredClone(scenario)]
            : structuredClone(PRESETS.slice(0, 3)),
        seeds: [scenario.seed],
        horizon: settings.horizon,
        codeVersion: CODE_VERSION,
      },
    } satisfies SearchCommand);
    setNotice(
      `Search started on ${settings.scope === 'current-factory' ? scenario.name : 'the benchmark set'}.`,
    );
  }
  function compare(horizon: number) {
    if (!candidate) return;
    importSequence.current.candidate++;
    const request = {
      requestId: `compare-${++searchSequence.current}`,
      revision: sim.revisionRef.current,
    };
    activeRequest.current = request;
    setActive('compare');
    setComparison(null);
    setCompareProgress(null);
    setError('');
    optimizer.current?.postMessage({
      ...request,
      type: 'compare',
      candidate,
      evaluation: {
        scope: 'current-factory',
        scenarios: [structuredClone(scenario)],
        seeds: [scenario.seed],
        horizon,
        codeVersion: CODE_VERSION,
      },
    } satisfies SearchCommand);
    setNotice('Comparing both policies on the current factory from tick 0.');
  }
  function exportResult(kind: 'best' | 'results' | 'comparison') {
    if (kind === 'best' && candidate)
      download('warehouselab-policy.json', {
        config: candidate,
        provenance: candidateTraining ? 'search' : 'imported',
        ...(candidateTraining ? { training: candidateTraining } : {}),
        codeVersion: CODE_VERSION,
      });
    if (kind === 'results' && result) download('warehouselab-search.json', result);
    if (kind === 'comparison' && comparison) download('warehouselab-comparison.json', comparison);
  }
  const commands = useRef({ save, undo, chooseTool, playback });
  commands.current = { save, undo, chooseTool, playback };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        (e.target instanceof HTMLElement &&
          (e.target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)))
      )
        return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        commands.current.undo(e.shiftKey);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        commands.current.save();
      } else if (e.key === 'Escape') commands.current.chooseTool('select');
      else if (!e.ctrlKey && !e.metaKey && ['v', 'h', 'w', 'e', 'm'].includes(e.key.toLowerCase()))
        commands.current.chooseTool(
          ({ v: 'select', h: 'pan', w: 'obstacle', e: 'erase', m: 'move' } as Record<string, Tool>)[
            e.key.toLowerCase()
          ],
        );
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  function select(value: Selection) {
    setSelection(value);
    setPanel('inspect');
  }
  function removeSelection() {
    if (!selection || selection.kind === 'cell') return;
    const selected = selection;
    const p =
      selected.kind === 'robot'
        ? scenario.robots.find((r) => r.id === selected.id)?.position
        : scenario.stations.find((s) => s.id === selected.id)?.position;
    if (p) edit({ type: 'paint', tool: 'erase', cells: [p] });
    setSelection(null);
  }
  function openDrawer(value: typeof drawer) {
    setDrawer(drawer === value ? null : value);
    if (value && value !== 'about') sim.send({ type: 'details' });
  }
  return (
    <div
      className={`app-shell ${panelOpen ? '' : 'panel-collapsed'}`}
      data-testid="workbench"
      data-revision={sim.revision}
      data-playing={sim.playing}
      data-busy={sim.busy}
      data-scenario-hash={scenarioHash}
    >
      <header className="topbar">
        <h1>WarehouseLab</h1>
        <span className="toolbar-divider" />
        <select
          aria-label="Factory preset"
          value={
            PRESETS.some((s) => s.id === scenario.id) &&
            contentHash(PRESETS.find((s) => s.id === scenario.id)) === scenarioHash
              ? scenario.id
              : ''
          }
          onChange={(e) => {
            const next = PRESETS.find((s) => s.id === e.target.value);
            if (next) loadScene(structuredClone(next));
          }}
        >
          <option value="" disabled>
            {scenario.name} · edited
          </option>
          {PRESETS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <details
          className="file-menu"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('button')) e.currentTarget.open = false;
          }}
        >
          <summary>File</summary>
          <div>
            <button onClick={newScene}>New scene</button>
            <button onClick={save}>Save locally</button>
            <button onClick={restore}>Restore</button>
            <button onClick={() => download('warehouselab-scene.json', bundle())}>
              Export JSON
            </button>
            <button onClick={() => fileInput.current?.click()}>Import JSON</button>
            <button onClick={() => openDrawer('about')}>About & diagnostics</button>
          </div>
        </details>
        <button className="desktop-action" onClick={save}>
          Save
        </button>
        <button className="desktop-action" onClick={() => fileInput.current?.click()}>
          Import
        </button>
        <span className="topbar-spacer" />
        <span className="mode-status">
          {editing
            ? 'Editing initial layout'
            : sim.busy
              ? 'Working…'
              : sim.playing
                ? 'Running'
                : 'Paused'}
        </span>
        <button
          className="panel-toggle"
          aria-label={panelOpen ? 'Collapse properties' : 'Open properties'}
          aria-expanded={panelOpen}
          onClick={() => setPanelOpen(!panelOpen)}
        >
          {panelOpen ? 'Hide panel' : 'Properties'}
        </button>
      </header>
      <main className="workspace">
        <nav className="tools" aria-label="Map tools">
          {TOOLS.map(([value, label]) => (
            <button
              key={value}
              data-testid={`tool-${value}`}
              aria-pressed={tool === value}
              className={tool === value ? 'selected' : ''}
              onClick={() => chooseTool(value)}
              title={`${label}${value === 'select' ? ' (V)' : value === 'pan' ? ' (H)' : value === 'obstacle' ? ' (W)' : value === 'erase' ? ' (E)' : value === 'move' ? ' (M)' : ''}`}
            >
              <Icon name={value} />
              <span>{label}</span>
            </button>
          ))}
          <span className="tool-gap" />
          <button aria-label="Undo" disabled={!historyCount.past} onClick={() => undo()}>
            <Icon name="undo" />
            <span>Undo</span>
          </button>
          <button aria-label="Redo" disabled={!historyCount.future} onClick={() => undo(true)}>
            <Icon name="redo" />
            <span>Redo</span>
          </button>
        </nav>
        <section className="map-area" aria-label="Factory workspace">
          <div className="map-controls">
            <span>
              {scenario.width} × {scenario.height} · {scenario.robots.length} robots
            </span>
            <button aria-label="Fit view" onClick={() => setFitSignal((n) => n + 1)}>
              <Icon name="fit" />
              Fit
            </button>
            <label>
              <input
                type="checkbox"
                checked={showPaths}
                onChange={(e) => setShowPaths(e.target.checked)}
              />
              All paths
            </label>
            <label>
              <input
                type="checkbox"
                checked={heatmap}
                onChange={(e) => setHeatmap(e.target.checked)}
              />
              Heatmap
            </label>
          </div>
          <CanvasMap
            scenario={scenario}
            store={sim.store}
            selection={selection}
            onSelect={select}
            tool={tool}
            editing={editing && !sim.playing && !sim.busy}
            onEdit={edit}
            validateEdit={(action) => previewEdit(scenario, action)}
            showPaths={showPaths}
            heatmap={heatmap}
            fitSignal={fitSignal}
            onDisplayTick={setDisplayTick}
          />
          <div className="map-status">
            <span>
              {editing
                ? 'Editing initial layout · finish gesture to apply'
                : 'Scroll to zoom · Space / middle drag to pan'}
            </span>
            <span className="mono">
              Display {fixed(displayTick, 1)} ·{' '}
              {sim.speed > 8 ? 'sampled' : `target ${6 * sim.speed} ticks/s`}
            </span>
          </div>
        </section>
        <aside className="side-panel" aria-label="Properties" hidden={!panelOpen}>
          <div className="panel-tabs" role="tablist" aria-label="Workbench panels">
            {(['inspect', 'policy', 'search'] as const).map((value) => (
              <button
                role="tab"
                key={value}
                aria-selected={panel === value}
                onClick={() => setPanel(value)}
              >
                {value === 'inspect' ? 'Inspector' : value === 'policy' ? 'Policy' : 'Optimize'}
                {value === 'search' && active ? (
                  <span aria-label="Calculation running"> ·</span>
                ) : null}
              </button>
            ))}
          </div>
          <div className="panel-body" hidden={panel !== 'inspect'}>
            <InspectorPanel
              key={sim.revision}
              scenario={scenario}
              inspection={sim.inspection}
              selection={selection}
              onSelect={select}
              onRobotCount={(n) => commitScene(withRobotCount(scenario, n))}
              onSeed={(n) => commitScene({ ...scenario, seed: n })}
              onStation={(id, key, n) => {
                const next = structuredClone(scenario);
                Object.assign(
                  next.stations.find((s) => s.id === id)!,
                  { [key]: n },
                );
                commitScene(next);
              }}
              onMove={() => chooseTool('move')}
              onRemove={removeSelection}
            />
          </div>
          <div className="panel-body" hidden={panel !== 'policy'}>
            <PolicyPanel
              config={config}
              onApply={(next) => {
                setEditing(false);
                setTool('select');
                reset(scenario, next, 'Policy applied. Ready to rerun from the initial layout.');
              }}
            />
          </div>
          <div className="panel-body" hidden={panel !== 'search'}>
            <OptimizePanel
              candidateTraining={candidateTraining}
              scenario={scenario}
              progress={progress}
              result={result}
              candidate={candidate}
              comparison={comparison}
              compareProgress={compareProgress}
              active={active}
              onSearch={search}
              onCancel={() => cancelActive()}
              onApply={() => {
                if (candidate) {
                  setEditing(false);
                  setTool('select');
                  reset(
                    scenario,
                    candidate,
                    'Candidate loaded on the current factory. Ready at tick 0.',
                  );
                }
              }}
              onCompare={compare}
              onExport={exportResult}
              onImport={() => candidateInput.current?.click()}
            />
          </div>
        </aside>
        {drawer && (
          <section className="details-drawer" aria-label={drawer}>
            <div className="section-heading">
              <h2>
                {drawer === 'about'
                  ? 'About & diagnostics'
                  : drawer === 'orders'
                    ? 'Orders'
                    : 'Event log'}
              </h2>
              <button aria-label="Close details" onClick={() => setDrawer(null)}>
                Close
              </button>
            </div>
            {drawer === 'about' ? (
              <>
                <p>
                  WarehouseLab · deterministic integer-tick production logistics. 1× = 6 ticks/s;
                  16× and above show sampled executed states.
                </p>
                <p>
                  V select · H pan · W wall · E erase · M move · Space + drag pan · Ctrl/⌘ Z undo ·
                  Shift Ctrl/⌘ Z redo · Ctrl/⌘ S save.
                </p>
                <dl className="diagnostic-grid">
                  <dt>Code</dt>
                  <dd>{CODE_VERSION}</dd>
                  <dt>Kernel</dt>
                  <dd>{KERNEL_VERSION}</dd>
                  <dt>Actual rate</dt>
                  <dd>{fixed(sim.inspection?.actualTicksPerSecond)} ticks/s</dd>
                  <dt>Checkpoints</dt>
                  <dd>{sim.inspection?.checkpoints ?? 0} / 24</dd>
                  <dt>Frame capture</dt>
                  <dd>{fixed(sim.inspection?.snapshotBuildMs, 3)} ms</dd>
                </dl>
                <p className="muted">
                  Snapshot messages target 20 Hz; properties update at 5 Hz. Canvas draws via
                  requestAnimationFrame. Long orders and logs are loaded on demand.
                </p>
                <button
                  disabled={!archived.length}
                  onClick={() => download('warehouselab-run-history.json', archived)}
                >
                  Export previous runs ({archived.length} / 3)
                </button>
                <p className="muted">
                  Includes cancelled superseded calculations with their original factory and started
                  simulation counts. The oldest archive is evicted after three runs.
                </p>
              </>
            ) : (
              <>
                <p className="muted">
                  Snapshot tick {sim.details?.tick ?? '…'}{' '}
                  <button onClick={() => sim.send({ type: 'details' })}>Refresh</button>
                </p>
                {drawer === 'orders' ? (
                  <table>
                    <thead>
                      <tr>
                        <th>Order</th>
                        <th>Destination</th>
                        <th>Arrived</th>
                        <th>Remaining</th>
                        <th>Completed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sim.details?.orders
                        .filter((o) => o.arrival <= sim.details!.tick)
                        .slice(-100)
                        .map((o) => (
                          <tr key={o.id}>
                            <td>{o.id}</td>
                            <td>{o.destination}</td>
                            <td>{o.arrival}</td>
                            <td>
                              {o.remaining} / {o.quantity}
                            </td>
                            <td>{o.completedAt ?? '—'}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="event-list">
                    {sim.details?.events
                      .slice(-100)
                      .reverse()
                      .map((e, i) => (
                        <p key={i}>
                          <span className="mono">{e.tick}</span> {e.message}
                        </p>
                      ))}
                  </div>
                )}
                <button
                  onClick={() => download('warehouselab-details.json', sim.details)}
                  disabled={!sim.details}
                >
                  Export full snapshot details
                </button>
                <p className="muted">
                  Showing up to 100 rows; export includes all orders and the bounded 400-event log.
                </p>
              </>
            )}
          </section>
        )}
      </main>
      <footer className="bottom-bar">
        <div className="playback-controls">
          <button className="primary" data-testid="play-pause" onClick={playback}>
            {sim.playing ? 'Pause' : sim.busy ? 'Pause / cancel seek' : 'Start'}
          </button>
          <button
            aria-label="Step +1"
            disabled={sim.playing || sim.busy}
            onClick={() => {
              setEditing(false);
              sim.send({ type: 'step' });
            }}
          >
            Step +1
          </button>
          <button
            aria-label="Reset"
            onClick={() => {
              setEditing(false);
              setTool('select');
              reset();
            }}
          >
            Reset
          </button>
          <select
            aria-label="Simulation speed"
            value={sim.speed}
            onChange={(e) => sim.send({ type: 'speed', speed: Number(e.target.value) })}
          >
            {[1, 2, 4, 8, 16, 32, 64].map((n) => (
              <option key={n} value={n}>
                {n}×
              </option>
            ))}
          </select>
          <span className="tick-label">
            Tick <strong data-testid="tick">{tick}</strong>
          </span>
          <input
            type="range"
            aria-label="Replay timeline"
            min={0}
            max={Math.max(1, maxTick)}
            value={Math.min(Number(replay) || 0, maxTick)}
            disabled={maxTick === 0}
            onChange={(e) => {
              const value = e.target.value;
              replayIntent.current = true;
              setReplay(value);
              clearTimeout(seekTimer.current);
              seekTimer.current = setTimeout(() => seek(value), 100);
            }}
            onPointerUp={() => seek(replay)}
          />
          <input
            aria-label="Replay tick"
            type="number"
            min={0}
            max={maxTick}
            value={replay}
            onChange={(e) => {
              replayIntent.current = true;
              setReplay(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') seek(replay);
            }}
          />
          <button disabled={maxTick === 0} onClick={() => seek(replay)}>
            Go to tick
          </button>
          <span className="recorded muted">/ {maxTick}</span>
        </div>
        <div className="metrics-strip">
          <span>
            Completed <strong data-testid="completed-orders">{metric?.completedOrders ?? 0}</strong>
          </span>
          <span>
            Unfinished <strong>{metric?.unfinishedOrders ?? 0}</strong>
          </span>
          <span>
            Oldest age <strong>{metric?.oldestUnfinishedAge ?? '—'}</strong>
          </span>
          <span>
            Orders / tick <strong>{fixed(metric?.throughput, 4)}</strong>
          </span>
          <span>
            Waiting <strong>{pct(metric?.waitingRatio ?? 0)}</strong>
          </span>
          <span className="secondary-metric">
            Delay <strong>{fixed(metric?.meanDelay)}</strong>
          </span>
          <span className="secondary-metric">
            Actual <strong>{fixed(sim.inspection?.actualTicksPerSecond)} ticks/s</strong>
          </span>
          <div className="metric-actions">
            <button onClick={() => openDrawer('orders')}>Orders</button>
            <button onClick={() => openDrawer('logs')}>Log</button>
            <button aria-label="About and diagnostics" onClick={() => openDrawer('about')}>
              ?
            </button>
          </div>
        </div>
        <div className="notice-bar">
          <span data-testid="notice" role="status">
            {sim.busy ? 'Waiting for an exact tick boundary…' : notice}
          </span>
          {sim.inspection?.warning && <span className="warning">{sim.inspection.warning}</span>}
        </div>
      </footer>
      {error && (
        <div className="error-toast" role="alert">
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError('')}>
            Dismiss
          </button>
        </div>
      )}
      <input
        hidden
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        aria-label="Import scene file"
        onChange={(e) => {
          void importFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <input
        hidden
        ref={candidateInput}
        type="file"
        accept=".json,application/json"
        aria-label="Import candidate file"
        onChange={(e) => {
          void importFile(e.target.files?.[0], true);
          e.target.value = '';
        }}
      />
      <span hidden data-testid="state-digest" data-digest={sim.digest} />
    </div>
  );
}
