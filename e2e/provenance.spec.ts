import { test, expect, type Download, type Page } from '@playwright/test';
import { contentHash } from '../src/core/model/random';
import type { PolicyConfig, Scenario } from '../src/core/model/types';
import type { FrozenEvaluation } from '../src/core/optimization/evaluation';
import type { SearchResult } from '../src/core/optimization/search';
import { BASELINE, QUEUE_AWARE } from '../src/core/policies/config';
import { PRESETS } from '../src/scenarios';
import type { SearchResponse } from '../src/workers/search-protocol';

test('narrow-screen File menu remains visible and usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await page.locator('.file-menu summary').click();
  for (const name of [
    'New scene',
    'Save locally',
    'Restore',
    'Export JSON',
    'Import JSON',
    'About & diagnostics',
  ]) {
    const button = page.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  await page.getByRole('button', { name: 'Save locally', exact: true }).click();
  await expect(page.getByText('Factory saved locally.', { exact: true })).toBeVisible();
});

interface CandidateExport {
  config: PolicyConfig;
  provenance: 'search' | 'imported';
  training?: FrozenEvaluation;
}
declare global {
  interface Window {
    __provenanceTrace: {
      searchWorker?: Worker;
      holdTerminals: boolean;
      delivering: boolean;
      held: SearchResponse[];
      pendingFiles: string[];
      settledFiles: string[];
      releaseFile: (name: string) => void;
    };
  }
}

/** Keep the real workers/kernel; delay only specific message and file-read boundaries. */
async function installControlledBoundaries(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const releases = new Map<string, () => void>();
    const trace: Window['__provenanceTrace'] = {
      holdTerminals: false,
      delivering: false,
      held: [],
      pendingFiles: [],
      settledFiles: [],
      releaseFile(name) {
        const release = releases.get(name);
        if (!release) throw new Error(`No delayed file read: ${name}`);
        release();
      },
    };
    window.__provenanceTrace = trace;
    const originalText = File.prototype.text;
    File.prototype.text = async function () {
      const text = await originalText.call(this);
      if (this.name.startsWith('delayed-')) {
        await new Promise<void>((resolve) => {
          releases.set(this.name, resolve);
          trace.pendingFiles.push(this.name);
        });
        releases.delete(this.name);
        trace.pendingFiles = trace.pendingFiles.filter((name) => name !== this.name);
        trace.settledFiles.push(this.name);
      }
      return text;
    };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (String(url).includes('search.worker')) {
          trace.searchWorker = this;
          this.addEventListener('message', (event: MessageEvent<SearchResponse>) => {
            if (
              !trace.delivering &&
              trace.holdTerminals &&
              (event.data.type === 'result' || event.data.type === 'comparison')
            ) {
              trace.held.push(event.data);
              event.stopImmediatePropagation();
            }
          });
        }
      }
    };
  });
}

async function boundary(page: Page): Promise<void> {
  await expect(page.getByTestId('workbench')).toHaveAttribute('data-busy', 'false');
}
async function openOptimize(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Optimize', exact: true }).click();
}
async function readJSON<T>(download: Download): Promise<T> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error('Missing export stream');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString()) as T;
}
async function exportJSON<T>(page: Page, button: string): Promise<T> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: button, exact: true }).click();
  return readJSON<T>(await pending);
}
async function importJSON(
  page: Page,
  kind: 'scene' | 'candidate',
  name: string,
  value: unknown,
): Promise<void> {
  await page.getByLabel(`Import ${kind} file`, { exact: true }).setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(value)),
  });
}
async function releaseFile(page: Page, name: string): Promise<void> {
  await page.evaluate(async (fileName) => {
    window.__provenanceTrace.releaseFile(fileName);
    // Cross the awaiting import continuation and React's commit before asserting.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }, name);
  await expect
    .poll(() => page.evaluate(() => window.__provenanceTrace.settledFiles))
    .toContain(name);
}
async function deliverHeld(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const trace = window.__provenanceTrace;
    trace.delivering = true;
    for (const data of trace.held.splice(0)) {
      trace.searchWorker!.dispatchEvent(new MessageEvent('message', { data }));
    }
    trace.delivering = false;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}
const scene = (id: string, seed: number): Scenario => ({
  ...structuredClone(PRESETS[0]),
  id,
  name: id,
  seed,
});

test('a cancelled search with no best preserves the previous candidate and its exact training origin', async ({
  page,
}) => {
  await page.goto('./');
  await boundary(page);
  await openOptimize(page);
  await page.getByRole('spinbutton', { name: 'Simulation budget', exact: true }).fill('2');
  await page.getByRole('spinbutton', { name: 'Evaluation horizon', exact: true }).fill('24');
  await page.getByTestId('start-search').click();
  await expect(page.getByTestId('search-progress')).toContainText('2 / 2 simulations');
  await expect(page.getByTestId('start-search')).toBeEnabled();
  const first = await exportJSON<CandidateExport>(page, 'Export best');
  expect(first.provenance).toBe('search');
  expect(first.training?.scenarioHashes).toEqual([contentHash(PRESETS[0])]);
  expect(first.training?.horizon).toBe(24);

  await page.getByRole('combobox', { name: 'Factory preset' }).selectOption('crossroads');
  await boundary(page);
  await page.getByRole('spinbutton', { name: 'Evaluation horizon', exact: true }).fill('100000');
  await page.getByTestId('start-search').click();
  await expect(page.getByTestId('search-progress')).toContainText('running');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByTestId('search-progress')).toContainText('cancelled');
  const cancelled = await exportJSON<SearchResult>(page, 'Export search results');
  expect(cancelled.best).toBeNull();
  expect(cancelled.evaluation.scenarioHashes).toEqual([contentHash(PRESETS[1])]);
  const retained = await exportJSON<CandidateExport>(page, 'Export best');
  expect(retained.config).toEqual(first.config);
  expect(retained.provenance).toBe('search');
  expect(retained.training).toEqual(first.training);
});

test('candidate import invalidates late completed search and comparison responses', async ({
  page,
}) => {
  await installControlledBoundaries(page);
  await page.goto('./');
  await boundary(page);
  await openOptimize(page);
  await page.getByRole('spinbutton', { name: 'Simulation budget', exact: true }).fill('2');
  await page.getByRole('spinbutton', { name: 'Evaluation horizon', exact: true }).fill('12');
  await page.evaluate(() => {
    window.__provenanceTrace.holdTerminals = true;
  });
  await page.getByTestId('start-search').click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__provenanceTrace.held.filter((m) => m.type === 'result').length),
    )
    .toBe(1);
  const imported = { ...QUEUE_AWARE, planningWindow: 21 };
  await importJSON(page, 'candidate', 'current-candidate.json', { config: imported });
  await expect(page.getByTestId('notice')).toContainText('Candidate imported');
  await expect(page.getByTestId('start-search')).toBeEnabled();
  await deliverHeld(page);
  const afterSearch = await exportJSON<CandidateExport>(page, 'Export best');
  expect(afterSearch.config).toEqual(imported);
  expect(afterSearch.provenance).toBe('imported');
  expect(afterSearch.training).toBeUndefined();

  await page.getByRole('button', { name: 'Compare baseline vs candidate', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__provenanceTrace.held.filter((m) => m.type === 'comparison').length,
      ),
    )
    .toBe(1);
  const newer = { ...BASELINE, planningWindow: 7, replanInterval: 1 };
  await importJSON(page, 'candidate', 'newer-candidate.json', { config: newer });
  await expect(page.getByTestId('notice')).toContainText('Candidate imported');
  await expect(page.getByTestId('start-search')).toBeEnabled();
  await deliverHeld(page);
  await expect(page.getByTestId('comparison')).not.toBeVisible();
  const afterCompare = await exportJSON<CandidateExport>(page, 'Export best');
  expect(afterCompare.config).toEqual(newer);
  expect(afterCompare.provenance).toBe('imported');
  expect(afterCompare.training).toBeUndefined();
});

test('a delayed scene import cannot overwrite a subsequently selected preset', async ({ page }) => {
  await installControlledBoundaries(page);
  await page.goto('./');
  await boundary(page);
  const name = 'delayed-before-preset.json';
  await importJSON(page, 'scene', name, {
    scenario: scene('outdated-import', 91),
    config: QUEUE_AWARE,
  });
  await expect
    .poll(() => page.evaluate(() => window.__provenanceTrace.pendingFiles))
    .toContain(name);
  await page.getByRole('combobox', { name: 'Factory preset' }).selectOption('hotspot');
  await boundary(page);
  await releaseFile(page, name);
  await boundary(page);
  await expect(page.getByRole('combobox', { name: 'Factory preset' })).toHaveValue('hotspot');
  await expect(page.getByTestId('workbench')).toHaveAttribute(
    'data-scenario-hash',
    contentHash(PRESETS[2]),
  );
});

test('the later scene import wins even when the earlier file read resolves last', async ({
  page,
}) => {
  await installControlledBoundaries(page);
  await page.goto('./');
  await boundary(page);
  const name = 'delayed-scene-first.json';
  await importJSON(page, 'scene', name, {
    scenario: scene('first-import', 93),
    config: QUEUE_AWARE,
  });
  await expect
    .poll(() => page.evaluate(() => window.__provenanceTrace.pendingFiles))
    .toContain(name);
  const latest = scene('second-import', 97);
  await importJSON(page, 'scene', 'scene-second.json', { scenario: latest, config: BASELINE });
  await expect(page.getByTestId('notice')).toContainText('imported and validated');
  await boundary(page);
  await releaseFile(page, name);
  await boundary(page);
  await expect(page.getByTestId('workbench')).toHaveAttribute(
    'data-scenario-hash',
    contentHash(latest),
  );
});

test('the later candidate import wins even when the earlier file read resolves last', async ({
  page,
}) => {
  await installControlledBoundaries(page);
  await page.goto('./');
  await boundary(page);
  await openOptimize(page);
  const name = 'delayed-candidate-first.json';
  await importJSON(page, 'candidate', name, { config: QUEUE_AWARE });
  await expect
    .poll(() => page.evaluate(() => window.__provenanceTrace.pendingFiles))
    .toContain(name);
  const latest = { ...BASELINE, planningWindow: 25 };
  await importJSON(page, 'candidate', 'candidate-second.json', { config: latest });
  await expect(page.getByTestId('notice')).toContainText('Candidate imported');
  await releaseFile(page, name);
  const exported = await exportJSON<CandidateExport>(page, 'Export best');
  expect(exported.config).toEqual(latest);
  expect(exported.provenance).toBe('imported');
  expect(exported.training).toBeUndefined();
});

test('switching stations with equal capacities discards unapplied station drafts', async ({
  page,
}) => {
  await page.goto('./');
  await boundary(page);
  await page.getByRole('combobox', { name: 'Factory preset' }).selectOption('hotspot');
  await boundary(page);
  const source = PRESETS[2].stations.find((station) => station.id === 'press-1')!;
  const target = PRESETS[2].stations.find((station) => station.id === 'press-2')!;
  expect(source.inputCapacity).toBe(target.inputCapacity);
  expect(source.outputCapacity).toBe(target.outputCapacity);
  await page.getByRole('combobox', { name: 'Inspect object' }).selectOption('station:press-1');
  const input = page.getByRole('spinbutton', { name: 'Station input capacity', exact: true });
  const output = page.getByRole('spinbutton', { name: 'Station output capacity', exact: true });
  await expect(input).toHaveValue(String(source.inputCapacity));
  await input.fill('17');
  await output.fill('19');
  await expect(
    page.getByRole('button', { name: 'Apply Station input capacity', exact: true }),
  ).toBeEnabled();
  await page.getByRole('combobox', { name: 'Inspect object' }).selectOption('station:press-2');
  await expect(input).toHaveValue(String(target.inputCapacity));
  await expect(output).toHaveValue(String(target.outputCapacity));
  await expect(
    page.getByRole('button', { name: 'Apply Station input capacity', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Apply Station output capacity', exact: true }),
  ).toBeDisabled();
  await page.getByRole('combobox', { name: 'Inspect object' }).selectOption('station:press-1');
  await expect(input).toHaveValue(String(source.inputCapacity));
  await expect(output).toHaveValue(String(source.outputCapacity));
  await expect(page.getByTestId('workbench')).toHaveAttribute(
    'data-scenario-hash',
    contentHash(PRESETS[2]),
  );
});
