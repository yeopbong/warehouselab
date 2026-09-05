import { test, expect, type Page } from '@playwright/test';
import { createSimulation, step, stateDigest } from '../src/core/sim/engine';
import { BASELINE } from '../src/core/policies/config';
import { PRESETS } from '../src/scenarios';

async function mapCell(page: Page, x: number, y: number) {
  const canvas = page.getByTestId('factory-map');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Map has no bounds');
  await expect(canvas).toHaveAttribute('data-cell-size', /\d/);
  const cell = Number(await canvas.getAttribute('data-cell-size'));
  const left = Number(await canvas.getAttribute('data-offset-x'));
  const top = Number(await canvas.getAttribute('data-offset-y'));
  await canvas.click({
    position: {
      x: left + (x + 0.5) * cell,
      y: top + (y + 0.5) * cell,
    },
  });
}

async function fileAction(page: Page, label: string) {
  const menu = page.locator('details.file-menu');
  if (!(await menu.evaluate((element) => (element as HTMLDetailsElement).open)))
    await menu.locator('summary').click();
  await menu.getByRole('button', { name: label, exact: true }).click();
  if (await menu.evaluate((element) => (element as HTMLDetailsElement).open))
    await menu.locator('summary').click();
}
async function boundary(page: Page) {
  await expect(page.getByTestId('workbench')).toHaveAttribute('data-busy', 'false');
}

test('real production, deterministic replay, inspection, editing, persistence, search and restart', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'WarehouseLab', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Simulation speed' }).selectOption('64');
  await page.getByTestId('play-pause').click();
  await expect
    .poll(async () => parseInt((await page.getByTestId('completed-orders').textContent())!, 10))
    .toBeGreaterThan(0);
  await expect
    .poll(async () => Number(await page.getByTestId('tick').textContent()))
    .toBeGreaterThanOrEqual(240);
  await page.getByTestId('play-pause').click();
  await expect(page.getByTestId('play-pause')).toHaveText('Start');
  await boundary(page);
  const paused = Number(await page.getByTestId('tick').textContent());
  await page.getByRole('button', { name: 'Step +1' }).click();
  await expect(page.getByTestId('tick')).toHaveText(String(paused + 1));
  await page.getByRole('spinbutton', { name: 'Replay tick', exact: true }).fill('240');
  await page.getByRole('button', { name: 'Go to tick' }).click();
  await expect(page.getByTestId('tick')).toHaveText('240');
  const expected = createSimulation(PRESETS[0], BASELINE, PRESETS[0].seed);
  for (let i = 0; i < 240; i++) step(expected);
  await expect(page.getByTestId('state-digest')).toHaveAttribute(
    'data-digest',
    stateDigest(expected),
  );
  await page.getByRole('combobox', { name: 'Inspect object' }).selectOption('robot:R1');
  await expect(page.getByTestId('robot-inspector')).toContainText('Committed tasks');
  await page.getByRole('combobox', { name: 'Inspect object' }).selectOption('station:press-1');
  await expect(page.getByTestId('station-inspector')).toContainText('Reserved output');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await boundary(page);
  await page.getByTestId('tool-obstacle').click();
  await boundary(page);
  await mapCell(page, 0, 0);
  await expect(page.getByTestId('notice')).toContainText('Scene updated');
  await fileAction(page, 'Save locally');
  await expect(page.getByTestId('notice')).toContainText('saved locally');
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('warehouselab.scenario.v1')!),
  );
  expect(saved.scenario.obstacles).toContainEqual({ x: 0, y: 0 });
  await page.reload();
  await fileAction(page, 'Restore');
  await expect(page.getByTestId('notice')).toContainText('restored');
  const savedState = createSimulation(saved.scenario, saved.config, saved.scenario.seed);
  await expect(page.getByTestId('state-digest')).toHaveAttribute(
    'data-digest',
    stateDigest(savedState),
  );
  await page.getByRole('tab', { name: 'Optimize', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Simulation budget', exact: true }).fill('6');
  await page.getByRole('spinbutton', { name: 'Evaluation horizon', exact: true }).fill('120');
  await page.getByTestId('start-search').click();
  await expect(page.getByTestId('load-best')).toBeEnabled({ timeout: 60_000 });
  await expect(page.getByTestId('search-progress')).toContainText('6 / 6');
  await page.getByTestId('load-best').click();
  await expect(page.getByTestId('tick')).toHaveText('0');
  await expect(page.getByTestId('notice')).toContainText('Candidate loaded');
  await page.getByRole('button', { name: 'Compare baseline vs candidate', exact: true }).click();
  await expect(page.getByTestId('comparison')).toContainText('120 ticks');
  await page.getByTestId('play-pause').click();
  await expect
    .poll(async () => parseInt((await page.getByTestId('completed-orders').textContent())!, 10))
    .toBeGreaterThan(0);
  await page.getByTestId('play-pause').click();
  expect(errors).toEqual([]);
});

test('validates JSON import, preserves exported scene, and reports cancelled search', async ({
  page,
}) => {
  await page.goto('./');
  const downloadPromise = page.waitForEvent('download');
  await fileAction(page, 'Export JSON');
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  if (!stream) throw new Error('Missing scene export');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const exported = Buffer.concat(chunks);
  await page
    .getByLabel('Import scene file', { exact: true })
    .setInputFiles({ name: 'scene.json', mimeType: 'application/json', buffer: exported });
  await expect(page.getByTestId('notice')).toContainText('imported and validated');
  await expect(page.getByTestId('state-digest')).toHaveAttribute(
    'data-digest',
    stateDigest(createSimulation(PRESETS[0], BASELINE, PRESETS[0].seed)),
  );
  await page.getByLabel('Import scene file', { exact: true }).setInputFiles({
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"schemaVersion":999}'),
  });
  await expect(page.getByRole('alert')).toContainText('Import rejected');
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  await page.getByRole('tab', { name: 'Optimize', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Simulation budget', exact: true }).fill('300');
  await page.getByTestId('start-search').click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByTestId('search-progress')).toContainText('cancelled', { timeout: 60_000 });
  await expect(page.getByTestId('start-search')).toBeEnabled();
  await page.getByLabel('Import candidate file', { exact: true }).setInputFiles({
    name: 'policy.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ config: BASELINE })),
  });
  const bestDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export best', exact: true }).click();
  const bestDownload = await bestDownloadPromise;
  const bestStream = await bestDownload.createReadStream();
  if (!bestStream) throw new Error('Missing candidate export');
  const bestChunks: Buffer[] = [];
  for await (const chunk of bestStream) bestChunks.push(chunk);
  const importedExport = JSON.parse(Buffer.concat(bestChunks).toString());
  expect(importedExport.provenance).toBe('imported');
  expect(importedExport.training).toBeUndefined();
  expect(importedExport.config).toEqual(BASELINE);
  await page.getByTestId('load-best').click();
  await expect(page.getByTestId('tick')).toHaveText('0');
});

test('map remains usable at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await expect(page.getByTestId('factory-map')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await page.getByRole('button', { name: 'Step +1' }).click();
  await expect(page.getByTestId('tick')).toHaveText('1');
  await page.getByRole('button', { name: 'Open properties', exact: true }).click();
  await page.getByRole('combobox', { name: 'Inspect object' }).selectOption('robot:R1');
  await expect(page.getByTestId('robot-inspector')).toBeVisible();
  await page.getByRole('button', { name: 'Collapse properties', exact: true }).click();
  await expect(page.getByTestId('play-pause')).toBeVisible();
});
