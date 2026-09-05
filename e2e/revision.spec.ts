import { test, expect, type Page, type Download } from '@playwright/test';
import { contentHash } from '../src/core/model/random';
import { createSimulation, step, stateDigest } from '../src/core/sim/engine';
import { BASELINE } from '../src/core/policies/config';
import { PRESETS } from '../src/scenarios';
import { makeDisplayFrame, type DisplayFrame } from '../src/ui/display';
import type { Scenario, PolicyConfig } from '../src/core/model/types';
import type { SearchResult } from '../src/core/optimization/search';

type CapturedFrame = { revision: number; requestId: number; frame: DisplayFrame };
type Pose = { id: string; x: number; y: number };
type DiagnosticCanvas = HTMLCanvasElement & {
  __warehouseDiagnostics: {
    tick: number;
    robots: Pose[];
    bitmapResizes: number;
    staticBuilds: number;
  };
};
declare global {
  interface Window {
    __revisionTrace: {
      frames: CapturedFrame[];
      displayed: { tick: number; robots: Pose[] }[];
      capture: boolean;
      boundaries: unknown[];
      simulationWorker?: Worker;
      commands: { kind: string; message: Record<string, unknown> }[];
      responses: { kind: string; type: string; revision: number; status?: string }[];
    };
  }
}

async function boundary(page: Page, tick?: number) {
  await expect(page.getByTestId('workbench')).toHaveAttribute('data-busy', 'false');
  if (tick !== undefined) await expect(page.getByTestId('tick')).toHaveText(String(tick));
}
async function fileAction(page: Page, label: string) {
  const menu = page.locator('details.file-menu');
  if (!(await menu.evaluate((element) => (element as HTMLDetailsElement).open)))
    await menu.locator('summary').click();
  await menu.getByRole('button', { name: label, exact: true }).click();
  if (await menu.evaluate((element) => (element as HTMLDetailsElement).open))
    await menu.locator('summary').click();
}
async function downloadJSON<T>(download: Download): Promise<T> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error('Missing download');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString()) as T;
}
async function exportedSearch(page: Page): Promise<SearchResult> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export search results', exact: true }).click();
  return downloadJSON<SearchResult>(await pending);
}
async function savedBundle(page: Page): Promise<{ scenario: Scenario; config: PolicyConfig }> {
  await fileAction(page, 'Save locally');
  return page.evaluate(() => JSON.parse(localStorage.getItem('warehouselab.scenario.v1')!));
}
async function cellPoint(page: Page, x: number, y: number) {
  const canvas = page.getByTestId('factory-map');
  await expect(canvas).toHaveAttribute('data-cell-size', /\d/);
  return canvas.evaluate(
    (element, point) => {
      const rect = element.getBoundingClientRect(),
        cell = Number(element.dataset.cellSize);
      return {
        x: rect.x + Number(element.dataset.offsetX) + (point.x + 0.5) * cell,
        y: rect.y + Number(element.dataset.offsetY) + (point.y + 0.5) * cell,
      };
    },
    { x, y },
  );
}
async function clickCell(page: Page, x: number, y: number) {
  const point = await cellPoint(page, x, y);
  await page.mouse.click(point.x, point.y);
}
async function pause(page: Page) {
  await page.getByTestId('play-pause').click();
  await expect(page.getByTestId('workbench')).toHaveAttribute('data-playing', 'false');
  await boundary(page);
}
function expectedDigest(scenario: Scenario, config: PolicyConfig, tick: number): string {
  const state = createSimulation(scenario, config, scenario.seed);
  while (state.tick < tick) step(state);
  return stateDigest(state);
}
async function observeWorkers(page: Page) {
  await page.addInitScript(() => {
    const trace: Window['__revisionTrace'] = {
      frames: [],
      displayed: [],
      capture: false,
      boundaries: [],
      commands: [],
      responses: [],
    };
    window.__revisionTrace = trace;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      kind: string;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.kind = String(url).includes('simulation.worker') ? 'simulation' : 'search';
        if (this.kind === 'simulation') trace.simulationWorker = this;
        this.addEventListener('message', (event) => {
          const data = event.data;
          trace.responses.push({
            kind: this.kind,
            type: data.type,
            revision: data.revision,
            status: data.result?.status ?? data.comparison?.status,
          });
          if (trace.responses.length > 600) trace.responses.shift();
          if (this.kind === 'simulation') {
            if (data.type === 'boundary') {
              trace.boundaries.push(data);
              if (trace.boundaries.length > 30) trace.boundaries.shift();
            }
            for (const frame of data.frames ?? (data.frame ? [data.frame] : []))
              trace.frames.push({ revision: data.revision, requestId: data.requestId, frame });
            if (trace.frames.length > 1000) trace.frames.splice(0, trace.frames.length - 1000);
          }
        });
      }
      postMessage(
        message: Record<string, unknown>,
        options?: Transferable[] | StructuredSerializeOptions,
      ) {
        trace.commands.push({ kind: this.kind, message });
        if (trace.commands.length > 100) trace.commands.shift();
        if (Array.isArray(options)) super.postMessage(message, options);
        else super.postMessage(message, options);
      }
    };
    const collect = () => {
      const canvas = document.querySelector(
        '[data-testid="factory-map"]',
      ) as DiagnosticCanvas | null;
      const d = canvas?.__warehouseDiagnostics;
      if (trace.capture && d) {
        trace.displayed.push({ tick: d.tick, robots: d.robots.map((robot) => ({ ...robot })) });
        if (trace.displayed.length > 500) trace.displayed.shift();
      }
      requestAnimationFrame(collect);
    };
    requestAnimationFrame(collect);
  });
}

test('current factory search freezes the edited layout and benchmark scope remains explicit', async ({
  page,
}) => {
  await observeWorkers(page);
  await page.goto('/');
  await boundary(page, 0);
  await page.getByTestId('tool-obstacle').click();
  await boundary(page, 0);
  await clickCell(page, 0, 0);
  await expect(page.getByTestId('notice')).toContainText('Scene updated');
  const saved = await savedBundle(page),
    editedHash = contentHash(saved.scenario);
  await page.getByRole('tab', { name: 'Optimize', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Search scope' })).toHaveValue('current-factory');
  await expect(page.getByText('1 simulation per candidate', { exact: false })).toBeVisible();
  await page.getByRole('spinbutton', { name: 'Evaluation horizon', exact: true }).fill('36');
  await page.getByRole('spinbutton', { name: 'Optimizer seed', exact: true }).fill('43');
  await page.getByRole('tab', { name: 'Inspector', exact: true }).click();
  await page.getByRole('tab', { name: 'Optimize', exact: true }).click();
  await expect(
    page.getByRole('spinbutton', { name: 'Evaluation horizon', exact: true }),
  ).toHaveValue('36');
  await expect(page.getByRole('spinbutton', { name: 'Optimizer seed', exact: true })).toHaveValue(
    '43',
  );
  await page.getByTestId('start-search').click();
  await expect(page.getByTestId('search-progress')).toContainText('6 / 6 simulations');
  await expect(page.getByTestId('start-search')).toBeEnabled();
  const current = await exportedSearch(page);
  expect(current.status).toBe('completed');
  expect(current.evaluation.scope).toBe('current-factory');
  expect(current.evaluationsPerCandidate).toBe(1);
  expect(current.evaluation.scenarios).toEqual([saved.scenario]);
  expect(current.evaluation.scenarioHashes).toEqual([editedHash]);
  expect(current.counters.simulations).toBe(6);
  expect(
    current.runs.every(
      (run) =>
        run.scenarioHash === editedHash && run.horizon === 36 && run.seed === saved.scenario.seed,
    ),
  ).toBe(true);
  await expect(page.getByTestId('result-origin')).toHaveAttribute('data-scenario-hash', editedHash);
  await page.getByRole('combobox', { name: 'Factory preset' }).selectOption('crossroads');
  await boundary(page, 0);
  await expect(page.getByTestId('result-origin')).toContainText('Current factory differs');
  await page.getByRole('combobox', { name: 'Search scope' }).selectOption('benchmark-set');
  await expect(page.getByText('3 simulations per candidate', { exact: false })).toBeVisible();
  await page.getByTestId('start-search').click();
  await expect(page.getByTestId('search-progress')).toContainText('6 / 6 simulations');
  await expect(page.getByTestId('start-search')).toBeEnabled();
  const benchmark = await exportedSearch(page);
  expect(benchmark.evaluation.scope).toBe('benchmark-set');
  expect(benchmark.evaluationsPerCandidate).toBe(3);
  expect(benchmark.evaluation.scenarios).toEqual(PRESETS.slice(0, 3));
  expect(benchmark.counters.simulations).toBe(6);
  expect(benchmark.evaluation.scenarioHashes).not.toContain(editedHash);
});

test('zoomed/panned wall strokes form one undo record and object moves preserve service geometry', async ({
  page,
}) => {
  await page.goto('/');
  await boundary(page, 0);
  const canvas = page.getByTestId('factory-map');
  const initialCell = Number(await canvas.getAttribute('data-cell-size'));
  const anchor = await cellPoint(page, 6, 5);
  await page.mouse.move(anchor.x, anchor.y);
  await page.mouse.wheel(0, -150);
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-cell-size')))
    .toBeGreaterThan(initialCell);
  const offset = Number(await canvas.getAttribute('data-offset-x'));
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(anchor.x + 35, anchor.y + 20);
  await page.mouse.up({ button: 'middle' });
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-offset-x')))
    .toBeCloseTo(offset + 35, 1);
  await page.getByTestId('tool-obstacle').click();
  await boundary(page, 0);
  const first = await cellPoint(page, 2, 5),
    last = await cellPoint(page, 9, 5);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  await page.mouse.move(last.x, last.y, { steps: 2 });
  await page.mouse.up();
  await expect(page.getByTestId('notice')).toContainText('Scene updated');
  expect((await savedBundle(page)).scenario.obstacles).toEqual(
    Array.from({ length: 8 }, (_, index) => ({ x: index + 2, y: 5 })),
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  expect((await savedBundle(page)).scenario.obstacles).toEqual([]);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect((await savedBundle(page)).scenario.obstacles).toHaveLength(8);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByTestId('tool-move').click();
  const source = await cellPoint(page, 6, 2),
    destination = await cellPoint(page, 7, 2);
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.mouse.move(destination.x, destination.y);
  await page.mouse.up();
  await expect(page.getByTestId('notice')).toContainText('Scene updated');
  const moved = (await savedBundle(page)).scenario.stations.find(
    (station) => station.id === 'press-1',
  )!;
  expect(moved.position).toEqual({ x: 7, y: 2 });
  expect(moved.service).toEqual({ x: 7, y: 3 });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(
    (await savedBundle(page)).scenario.stations.find((station) => station.id === 'press-1'),
  ).toEqual(PRESETS[0].stations.find((station) => station.id === 'press-1'));
});

test('number drafts accept multiple digits, commit once, and reject invalid values without resetting', async ({
  page,
}) => {
  await page.goto('/');
  await boundary(page, 0);
  const workbench = page.getByTestId('workbench'),
    revision = Number(await workbench.getAttribute('data-revision'));
  const count = page.getByRole('spinbutton', { name: 'Robot count', exact: true });
  await count.fill('');
  await count.pressSequentially('12');
  await expect(count).toHaveValue('12');
  await expect(workbench).toHaveAttribute('data-revision', String(revision));
  await page.getByRole('button', { name: 'Apply Robot count', exact: true }).click();
  await boundary(page, 0);
  await expect(workbench).toHaveAttribute('data-revision', String(revision + 1));
  await expect(page.getByRole('button', { name: 'Apply Robot count', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Step +1', exact: true }).click();
  await boundary(page, 1);
  const digest = await page.getByTestId('state-digest').getAttribute('data-digest');
  await count.fill('25');
  await page.getByRole('button', { name: 'Apply Robot count', exact: true }).click();
  await expect(count).toHaveAttribute('aria-invalid', 'true');
  await expect(workbench).toHaveAttribute('data-revision', String(revision + 1));
  await expect(page.getByTestId('tick')).toHaveText('1');
  await expect(page.getByTestId('state-digest')).toHaveAttribute('data-digest', digest!);
  await page.getByRole('tab', { name: 'Policy', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Planning window', exact: true }).fill('16');
  await page.getByRole('tab', { name: 'Inspector', exact: true }).click();
  await page.getByRole('tab', { name: 'Policy', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Planning window', exact: true })).toHaveValue(
    '16',
  );
  await expect(workbench).toHaveAttribute('data-revision', String(revision + 1));
  await page.getByRole('button', { name: 'Apply policy & reset', exact: true }).click();
  await boundary(page, 0);
  await expect(workbench).toHaveAttribute('data-revision', String(revision + 2));
});

test('Escape and same-factory undo cancel unfinished pointer gestures before they can commit', async ({
  page,
}) => {
  await page.goto('/');
  await boundary(page, 0);
  await page.getByTestId('tool-obstacle').click();
  await boundary(page, 0);
  const workbench = page.getByTestId('workbench');
  const revision = await workbench.getAttribute('data-revision');
  const beginStroke = async () => {
    const from = await cellPoint(page, 2, 5),
      to = await cellPoint(page, 6, 5);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 2 });
  };
  await beginStroke();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.up();
  await expect(workbench).toHaveAttribute('data-revision', revision!);
  expect((await savedBundle(page)).scenario.obstacles).toEqual([]);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByTestId('tool-obstacle').click();
  await clickCell(page, 0, 0);
  await expect(page.getByTestId('notice')).toContainText('Scene updated');
  await boundary(page, 0);
  await beginStroke();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await boundary(page, 0);
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  expect((await savedBundle(page)).scenario.obstacles).toEqual([]);
  await expect(workbench).toHaveAttribute('data-scenario-hash', contentHash(PRESETS[0]));
});

test('real worker trajectories drive displayed turns, waits and cargo; playback and replay match the CLI kernel', async ({
  page,
}) => {
  await observeWorkers(page);
  await page.goto('/');
  await boundary(page, 0);
  await page.getByRole('combobox', { name: 'Simulation speed' }).selectOption('4');
  await boundary(page, 0);
  await page.evaluate(() => {
    window.__revisionTrace.capture = true;
  });
  await page.getByTestId('play-pause').click();
  await expect
    .poll(async () => Number(await page.getByTestId('tick').textContent()))
    .toBeGreaterThanOrEqual(65);
  const point = await page.getByTestId('factory-map').evaluate((element) => {
    const canvas = element as DiagnosticCanvas,
      robot = canvas.__warehouseDiagnostics.robots[0],
      rect = canvas.getBoundingClientRect(),
      cell = Number(canvas.dataset.cellSize);
    return {
      id: robot.id,
      x: rect.x + Number(canvas.dataset.offsetX) + (robot.x + 0.5) * cell,
      y: rect.y + Number(canvas.dataset.offsetY) + (robot.y + 0.5) * cell,
    };
  });
  await page.mouse.click(point.x, point.y);
  await expect(page.getByRole('combobox', { name: 'Inspect object' })).toHaveValue(
    `robot:${point.id}`,
  );
  await pause(page);
  await page.evaluate(() => {
    window.__revisionTrace.capture = false;
  });
  const captured = await page.evaluate(() => ({
    frames: window.__revisionTrace.frames,
    displayed: window.__revisionTrace.displayed,
  }));
  const frames = captured.frames.filter((value) => value.revision === 0);
  const end = Math.max(...frames.map((value) => value.frame.tick));
  const state = createSimulation(PRESETS[0], BASELINE, PRESETS[0].seed),
    expected = new Map<number, DisplayFrame>([[0, makeDisplayFrame(state)]]);
  while (state.tick < end) {
    step(state);
    expected.set(state.tick, makeDisplayFrame(state));
  }
  for (const value of frames) expect(value.frame).toEqual(expected.get(value.frame.tick));
  expect(frames.some((value) => value.frame.robots.some((robot) => robot.load))).toBe(true);
  expect(
    frames.some((value) =>
      value.frame.robots.some(
        (robot) => robot.status === 'loading' || robot.status === 'unloading',
      ),
    ),
  ).toBe(true);
  let fractional = 0,
    turns = 0,
    stationary = 0;
  const directions = new Map<string, { x: number; y: number }>();
  for (let tick = 1; tick <= end; tick++)
    for (const robot of expected.get(tick)!.robots) {
      const previous = expected.get(tick - 1)!.robots.find((value) => value.id === robot.id)!;
      const direction = {
        x: robot.position.x - previous.position.x,
        y: robot.position.y - previous.position.y,
      };
      if (!direction.x && !direction.y) stationary++;
      else {
        const old = directions.get(robot.id);
        if (old && old.x * direction.x + old.y * direction.y === 0) turns++;
        directions.set(robot.id, direction);
      }
    }
  for (const sample of captured.displayed) {
    const floor = Math.floor(sample.tick),
      alpha = sample.tick - floor;
    const from = expected.get(floor),
      to = expected.get(floor + 1);
    if (!from) continue;
    if (alpha > 0.01 && alpha < 0.99) fractional++;
    for (const pose of sample.robots) {
      const a = from.robots.find((robot) => robot.id === pose.id)!,
        b = to?.robots.find((robot) => robot.id === pose.id) ?? a;
      expect(pose.x).toBeCloseTo(a.position.x + (b.position.x - a.position.x) * alpha, 6);
      expect(pose.y).toBeCloseTo(a.position.y + (b.position.y - a.position.y) * alpha, 6);
    }
  }
  expect(fractional).toBeGreaterThan(20);
  expect(turns).toBeGreaterThan(0);
  expect(stationary).toBeGreaterThan(0);
  const pausedTick = Number(await page.getByTestId('tick').textContent());
  await expect(page.getByTestId('state-digest')).toHaveAttribute(
    'data-digest',
    expectedDigest(PRESETS[0], BASELINE, pausedTick),
  );
  await page.getByRole('combobox', { name: 'Simulation speed' }).selectOption('64');
  await page.getByTestId('play-pause').click();
  await expect
    .poll(async () => Number(await page.getByTestId('tick').textContent()))
    .toBeGreaterThanOrEqual(400);
  await expect(page.getByTestId('factory-map')).toHaveAttribute('data-sampled', 'true');
  await pause(page);
  const fastTick = Number(await page.getByTestId('tick').textContent());
  await expect(page.getByTestId('state-digest')).toHaveAttribute(
    'data-digest',
    expectedDigest(PRESETS[0], BASELINE, fastTick),
  );
  for (const target of [311, 73, 237]) {
    await page.getByRole('spinbutton', { name: 'Replay tick', exact: true }).fill(String(target));
    await page.getByRole('button', { name: 'Go to tick', exact: true }).click();
  }
  await boundary(page, 237);
  await expect(page.getByTestId('state-digest')).toHaveAttribute(
    'data-digest',
    expectedDigest(PRESETS[0], BASELINE, 237),
  );
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await boundary(page, 0);
  // Deliver a genuinely captured old response after reset to exercise the late-message guard.
  await page.evaluate(() => {
    const trace = window.__revisionTrace;
    const old = trace.boundaries.find(
      (value) => (value as { frame: DisplayFrame }).frame.tick > 20,
    );
    trace.simulationWorker!.dispatchEvent(new MessageEvent('message', { data: old }));
  });
  await expect(page.getByTestId('state-digest')).toHaveAttribute(
    'data-digest',
    expectedDigest(PRESETS[0], BASELINE, 0),
  );
  await expect
    .poll(() =>
      page
        .getByTestId('factory-map')
        .evaluate((element) => (element as DiagnosticCanvas).__warehouseDiagnostics.tick),
    )
    .toBe(0);
  const restored = await page
    .getByTestId('factory-map')
    .evaluate((element) => (element as DiagnosticCanvas).__warehouseDiagnostics.robots);
  expect(restored.map(({ id, x, y }) => ({ id, position: { x, y } }))).toEqual(PRESETS[0].robots);
});

test('search and comparison cancel at safe boundaries, and scene changes reject their old results', async ({
  page,
}) => {
  await observeWorkers(page);
  await page.goto('/');
  await boundary(page, 0);
  await page.getByRole('tab', { name: 'Optimize', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Simulation budget', exact: true }).fill('3000');
  await page.getByRole('spinbutton', { name: 'Evaluation horizon', exact: true }).fill('100000');
  await page.getByTestId('start-search').click();
  await expect(page.getByTestId('search-progress')).toContainText('running');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByTestId('search-progress')).toContainText('cancelled', { timeout: 5000 });
  const cancelled = await exportedSearch(page);
  expect(cancelled.status).toBe('cancelled');
  expect(cancelled.counters.simulations).toBeGreaterThanOrEqual(1);
  expect(cancelled.best).toBeNull();
  expect(cancelled.records.every((record) => record.status !== 'completed')).toBe(true);
  await page.getByLabel('Import candidate file', { exact: true }).setInputFiles({
    name: 'baseline.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ config: BASELINE })),
  });
  await page.getByRole('button', { name: 'Compare baseline vs candidate', exact: true }).click();
  await expect(page.getByTestId('search-progress')).toContainText('Comparing');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByTestId('comparison')).toContainText('cancelled', { timeout: 5000 });
  await page.getByRole('button', { name: 'Compare baseline vs candidate', exact: true }).click();
  await expect(page.getByTestId('search-progress')).toContainText('Comparing');
  await page.getByRole('combobox', { name: 'Factory preset' }).selectOption('crossroads');
  await boundary(page, 0);
  await expect(page.getByTestId('comparison')).not.toBeVisible();
  await expect(page.getByTestId('state-digest')).toHaveAttribute(
    'data-digest',
    expectedDigest(PRESETS[1], BASELINE, 0),
  );
  await page.getByTestId('start-search').click();
  await expect(page.getByTestId('search-progress')).toContainText('running');
  await page.getByRole('combobox', { name: 'Factory preset' }).selectOption('hotspot');
  await boundary(page, 0);
  await expect(page.getByTestId('start-search')).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__revisionTrace.responses.filter(
            (value) => value.kind === 'search' && value.status === 'cancelled',
          ).length,
      ),
    )
    .toBeGreaterThanOrEqual(4);
  await expect(page.getByTestId('state-digest')).toHaveAttribute(
    'data-digest',
    expectedDigest(PRESETS[2], BASELINE, 0),
  );
  await expect(page.getByTestId('comparison')).not.toBeVisible();
  await expect(page.getByTestId('workbench')).toHaveAttribute(
    'data-scenario-hash',
    contentHash(PRESETS[2]),
  );
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
]) {
  test(`${viewport.width}×${viewport.height} keeps map and primary controls inside the viewport in run, edit and search modes`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await boundary(page, 0);
    const check = async () => {
      const size = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      }));
      expect(size.width).toBeLessThanOrEqual(viewport.width);
      expect(size.height).toBeLessThanOrEqual(viewport.height);
      for (const locator of [
        page.getByTestId('factory-map'),
        page.getByTestId('play-pause'),
        page.getByTestId('tool-obstacle'),
        page.getByRole('button', { name: 'Step +1', exact: true }),
        page.getByRole('button', { name: 'Reset', exact: true }),
        page.getByRole('button', { name: 'Fit view', exact: true }),
      ]) {
        await expect(locator).toBeVisible();
        const bounds = await locator.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.y).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
      }
    };
    await page.getByTestId('play-pause').click();
    await expect(page.getByTestId('workbench')).toHaveAttribute('data-playing', 'true');
    await check();
    await pause(page);
    await page.getByTestId('tool-obstacle').click();
    await boundary(page, 0);
    await check();
    await page.getByRole('tab', { name: 'Optimize', exact: true }).click();
    await page.getByRole('spinbutton', { name: 'Evaluation horizon', exact: true }).fill('100000');
    await page.getByTestId('start-search').click();
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    await check();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByTestId('search-progress')).toContainText('cancelled');
  });
}
