import { expect, test, type Download, type Page } from '@playwright/test';
import { gunzipSync } from 'node:zlib';
import type { Catalog, RunTrace, Study } from '../src/sorting/types';
import type { ResearchResults } from '../src/sorting/MethodComparison';

const live = process.env.PW_SORTING_LIVE === '1';

async function currentStudy(page: Page): Promise<Study> {
  const root = new URL(page.url());
  root.hash = '';
  const directory = live ? 'api/sorting/' : 'sorting/';
  const catalogResponse = await page.request.get(
    new URL(`${directory}${live ? 'catalog' : 'catalog.json'}`, root).href,
  );
  expect(catalogResponse.ok()).toBe(true);
  const catalog = (await catalogResponse.json()) as Catalog;
  const id = await page
    .getByRole('combobox', { name: 'Recorded experiment', exact: true })
    .inputValue();
  expect(catalog.studies.some((entry) => entry.id === id)).toBe(true);
  const recordResponse = await page.request.get(
    new URL(`${directory}studies/${id}${live ? '' : '.json'}`, root).href,
  );
  expect(recordResponse.ok()).toBe(true);
  return (await recordResponse.json()) as Study;
}

async function exported(download: Download): Promise<Study> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error('Missing exported record.');
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part);
  return JSON.parse(Buffer.concat(parts).toString()) as Study;
}

test('saved sorting records connect measured candidates, predictions and legal mapping edits', async ({
  page,
}) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
  });
  await page.goto('./#sorting');
  await expect(page.getByTestId('sorting-workspace')).toBeVisible();
  await expect(
    page.getByRole('combobox', { name: 'Selected candidate', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('sorting-workspace.png'), fullPage: true });
  const record = await currentStudy(page);
  const candidate = record.candidates.find((entry) => entry.prediction && entry.throughput != null);
  expect(
    candidate,
    'The published study must include a real model-selected evaluation.',
  ).toBeTruthy();
  await page
    .getByRole('button', {
      name: `Select ${candidate!.id}, ${candidate!.throughput!.toFixed(4)} parcels per tick, ${candidate!.calls} calls`,
      exact: true,
    })
    .click();
  await expect(page.getByRole('combobox', { name: 'Selected candidate', exact: true })).toHaveValue(
    candidate!.id,
  );
  await expect(page.getByRole('region', { name: 'Selected candidate details' })).toContainText(
    candidate!.throughput!.toFixed(4),
  );
  await page.getByRole('tab', { name: 'Prediction errors', exact: true }).click();
  await expect(page.getByTestId('zone-distribution').locator('.zone-cell')).toHaveCount(12);
  await page.getByRole('combobox', { name: 'Distribution view' }).selectOption('predicted');
  await expect(
    page.getByText('Prediction frozen before evaluation', { exact: false }),
  ).toBeVisible();
  await page.getByRole('combobox', { name: 'Operational signal' }).selectOption('closedFraction');
  await page.getByRole('combobox', { name: 'Distribution view' }).selectOption('residual');
  const measured = candidate!.evaluations.filter(
    (evaluation) => evaluation.status === 'completed' && evaluation.auxiliary,
  );
  const residual =
    measured.reduce((sum, run) => sum + run.auxiliary!.zones[0].closedFraction, 0) /
      measured.length -
    candidate!.prediction!.auxiliary.zones[0].closedFraction;
  await expect(
    page.getByTestId('zone-distribution').locator('.zone-cell strong').first(),
  ).toHaveText(`${residual > 0 ? '+' : ''}${(residual * 100).toFixed(1)} pp`);
  await page.getByRole('tab', { name: 'Mapping', exact: true }).click();
  const other = candidate!.mapping.findIndex(
    (destination) => destination !== candidate!.mapping[0],
  );
  expect(other).toBeGreaterThan(0);
  await page.getByRole('combobox', { name: 'Chute to edit', exact: true }).selectOption('0');
  await page.getByRole('combobox', { name: 'Swap chute', exact: true }).selectOption(String(other));
  await page.getByRole('button', { name: 'Swap', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Edited mapping · not evaluated', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('2 unmeasured changes', { exact: true })).toBeVisible();
  await expect(page.getByText('All destination quotas satisfied.', { exact: true })).toBeVisible();
  if (!live)
    await expect(
      page.getByRole('button', { name: 'Evaluate fixed mapping', exact: true }),
    ).toBeDisabled();
  await page.getByRole('button', { name: 'Reset changes', exact: true }).click();
  await expect(page.getByText('Recorded mapping', { exact: true })).toBeVisible();
  const counts = new Map(
    record.scenario.destinations.map((destination) => [
      destination.id,
      candidate!.mapping.filter((id) => id === destination.id).length,
    ]),
  );
  const donor = record.scenario.destinations.find(
    (destination) => counts.get(destination.id)! > destination.minChutes,
  );
  const receiver = record.scenario.destinations.find(
    (destination) =>
      destination.id !== donor?.id && counts.get(destination.id)! < destination.maxChutes,
  );
  expect(donor).toBeTruthy();
  expect(receiver).toBeTruthy();
  await page
    .getByRole('combobox', { name: 'Chute to edit', exact: true })
    .selectOption(String(candidate!.mapping.indexOf(donor!.id)));
  await page
    .getByRole('combobox', { name: 'Transfer destination', exact: true })
    .selectOption(receiver!.id);
  await page.getByRole('button', { name: 'Transfer', exact: true }).click();
  await expect(page.getByText('1 unmeasured change', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reset changes', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export record', exact: true }).click();
  const downloaded = await exported(await pending);
  expect(downloaded).toEqual(record);
  await page.getByLabel('Import sorting study', { exact: true }).setInputFiles({
    name: 'saved-study.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(downloaded)),
  });
  await expect(page.getByText('Imported record', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Evaluate fixed mapping', exact: true }),
  ).toBeDisabled();
  await expect(page.getByText('Imported records are read-only.', { exact: false })).toBeVisible();
  await page.getByLabel('Import sorting study', { exact: true }).setInputFiles({
    name: 'incomplete-record.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...downloaded, candidates: [{}] })),
  });
  await expect(page.getByRole('alert')).toHaveText(
    'This file is not a complete, supported sorting study.',
  );
  await expect(
    page.getByRole('combobox', { name: 'Selected candidate', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('combobox', { name: 'Selected candidate', exact: true }),
  ).toBeVisible();
  expect(failures).toEqual([]);
});

test('two recorded executions support synchronized replay and business-event inspection', async ({
  page,
}) => {
  await page.goto('./#sorting');
  await expect(
    page.getByRole('combobox', { name: 'Selected candidate', exact: true }),
  ).toBeVisible();
  const record = await currentStudy(page);
  const recorded = record.candidates.filter((candidate) =>
    candidate.evaluations.some(
      (evaluation) => evaluation.status === 'completed' && evaluation.traceUrl,
    ),
  );
  expect(
    recorded.length,
    'The published study needs two actual recorded executions.',
  ).toBeGreaterThanOrEqual(2);
  await page.getByRole('tab', { name: 'Run comparison', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Run A candidate', exact: true })
    .selectOption(recorded[0].id);
  await page
    .getByRole('combobox', { name: 'Run B candidate', exact: true })
    .selectOption(recorded.at(-1)!.id);
  await expect(page.getByRole('button', { name: 'Play replay', exact: true })).toBeEnabled();
  const slider = page.getByRole('slider', { name: 'Comparison replay tick' });
  const maximum = Number(await slider.getAttribute('max'));
  expect(maximum).toBeGreaterThan(0);
  await page
    .getByRole('spinbutton', { name: 'Comparison tick', exact: true })
    .fill(String(maximum));
  const a = page.getByRole('region', { name: 'Run A', exact: true });
  const b = page.getByRole('region', { name: 'Run B', exact: true });
  await expect(a.getByTestId('sorting-map')).toBeVisible();
  await expect(b.getByTestId('sorting-map')).toBeVisible();
  const firstEvaluation = recorded[0].evaluations.find(
    (evaluation) => evaluation.status === 'completed' && evaluation.traceUrl,
  )!;
  const firstTraceURL =
    live && firstEvaluation.traceUrl!.startsWith('/api/')
      ? new URL(firstEvaluation.traceUrl!, page.url()).href
      : new URL(firstEvaluation.traceUrl!, page.url().split('#')[0]).href;
  const traceResponse = await page.request.get(firstTraceURL);
  expect(traceResponse.ok()).toBe(true);
  const traceBytes = await traceResponse.body();
  const trace = JSON.parse(
    (traceBytes[0] === 0x1f && traceBytes[1] === 0x8b
      ? gunzipSync(traceBytes)
      : traceBytes
    ).toString(),
  ) as RunTrace;
  const closedCells = new Set<number>();
  for (const event of trace.events) {
    if (event.chute == null) continue;
    if (event.type === 'close') closedCells.add(event.chute);
    if (event.type === 'open') closedCells.delete(event.chute);
  }
  await expect(a.getByTestId('closed-chute-count')).toHaveText(String(closedCells.size));
  await a.getByRole('combobox', { name: 'Run A events', exact: true }).selectOption('all');
  await expect(page.getByTestId('trace-events-a').getByRole('button').first()).toBeVisible();
  await page.getByTestId('trace-events-a').getByRole('button').first().click();
  await expect(a.getByRole('combobox', { name: 'Run A robot', exact: true })).not.toHaveValue('');
  await page.getByRole('combobox', { name: 'Replay curve measure' }).selectOption('reroutes');
  await expect(page.getByRole('img', { name: 'Recorded cumulative reroutes' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('sorting-replay.png'), fullPage: true });
});

test('sorting controls fit narrow screens without hiding the simulator distinction', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./#sorting');
  await expect(
    page.getByRole('combobox', { name: 'Selected candidate', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(live ? 'Local simulator connected' : 'Saved experiments', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.getByRole('link', { name: 'Factory workspace ↗', exact: true }).click();
  await expect(page.getByTestId('workbench')).toHaveAttribute('data-busy', 'false');
  await page.getByRole('button', { name: 'Step +1', exact: true }).click();
  await expect(page.getByTestId('tick')).toHaveText('1');
});

test('method comparisons display the independent measurements and separate historical cost', async ({
  page,
}) => {
  await page.goto('./#sorting');
  const panel = page.getByTestId('method-comparison');
  await expect(panel).toBeVisible();
  await panel.locator('summary').click();
  const response = await page.request.get(
    new URL('sorting/results.json', page.url().split('#')[0]).href,
  );
  expect(response.ok()).toBe(true);
  const results = (await response.json()) as ResearchResults;
  const conditions = [...new Set(results.groups.map((row) => row.scenarioId))];
  for (const condition of conditions) {
    await panel
      .getByRole('combobox', { name: 'Method comparison condition' })
      .selectOption(condition);
    for (const regime of ['cold', 'history']) {
      await panel.getByRole('combobox', { name: 'Method comparison setting' }).selectOption(regime);
      const expected = results.groups.filter(
        (row) => row.scenarioId === condition && row.regime === regime,
      );
      const rows = panel.locator('table').first().locator('tbody tr');
      await expect(rows).toHaveCount(Math.max(1, expected.length));
      for (const [index, row] of expected.entries()) {
        const cells = rows.nth(index).getByRole('cell');
        await expect(cells.nth(1)).toHaveText(row.mean == null ? '—' : row.mean.toFixed(4));
        await expect(cells.nth(2)).toHaveText(
          row.interval95
            ? `${row.interval95[0].toFixed(4)} – ${row.interval95[1].toFixed(4)}`
            : '—',
        );
        await expect(cells.nth(3)).toHaveText(
          `${row.optimizerRuns}${row.failedOptimizerRuns ? ` · ${row.failedOptimizerRuns} failed` : ''}${row.inProgressOptimizerRuns ? ` · ${row.inProgressOptimizerRuns} running` : ''}`,
        );
        await expect(cells.nth(4)).toHaveText(String(row.simulationRuns));
      }
      if (regime === 'history')
        await expect(panel).toContainText(
          `Historical learning additionally uses ${results.costsByPhase['history-data'].started} offline simulation calls`,
        );
    }
    const references =
      results.originalEAReference?.groups?.filter((row) => row.scenarioId === condition) ?? [];
    if (references.length) {
      const section = panel.getByRole('region', { name: 'Pinned upstream EA comparison' });
      await expect(
        section.getByRole('heading', { name: 'Upstream EA · matched budget' }),
      ).toBeVisible();
      const rows = section.locator('tbody tr');
      await expect(rows).toHaveCount(references.length);
      for (const [index, row] of references.entries()) {
        await expect(rows.nth(index).getByRole('cell').nth(1)).toHaveText(
          row.mean == null ? '—' : row.mean.toFixed(4),
        );
      }
      if (results.originalEAReference?.costs)
        await expect(section).toContainText(
          `${results.originalEAReference.costs.started.toLocaleString()} true calls across all its conditions`,
        );
    } else
      await expect(
        panel.getByRole('region', { name: 'Pinned upstream EA comparison' }),
      ).toHaveCount(0);
  }
  const cost = results.overallStudyCost ?? results.totalResearchCost ?? results.totalCost;
  await expect(panel.locator('.research-cost')).toContainText(
    `Reported study: ${cost.started.toLocaleString()} true calls`,
  );
  if (results.status !== 'completed') await expect(panel).toContainText('study still in progress');
  await panel.screenshot({ path: test.info().outputPath('method-comparison.png') });
});

test('a legal manual edit executes the real local simulator and preserves a measured record', async ({
  page,
}) => {
  test.skip(
    !live,
    'Requires the original simulator service; static hosting cannot execute new runs.',
  );
  test.setTimeout(180_000);
  await page.goto('./#sorting');
  await expect(page.getByTestId('sorting-workspace')).toHaveAttribute('data-mode', 'live');
  await expect(
    page.getByRole('combobox', { name: 'Selected candidate', exact: true }),
  ).toBeVisible();
  const record = await currentStudy(page);
  const id = await page
    .getByRole('combobox', { name: 'Selected candidate', exact: true })
    .inputValue();
  const candidate = record.candidates.find((entry) => entry.id === id)!;
  const other = candidate.mapping.findIndex((destination) => destination !== candidate.mapping[0]);
  await page.getByRole('combobox', { name: 'Chute to edit', exact: true }).selectOption('0');
  await page.getByRole('combobox', { name: 'Swap chute', exact: true }).selectOption(String(other));
  await page.getByRole('button', { name: 'Swap', exact: true }).click();
  await page.getByRole('textbox', { name: 'Simulation seeds', exact: true }).fill('937');
  await page
    .getByRole('spinbutton', { name: 'Fixed-map evaluation horizon', exact: true })
    .fill('300');
  await page.getByRole('button', { name: 'Evaluate fixed mapping', exact: true }).click();
  await expect(
    page.getByText('Evaluation finished. Select a candidate to inspect its measured result.', {
      exact: true,
    }),
  ).toBeVisible({ timeout: 120_000 });
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export record', exact: true }).click();
  const measured = await exported(await pending);
  expect(measured.id).not.toBe(record.id);
  expect(measured.regime).toBe('manual');
  expect(measured.candidates[0].mapping).not.toEqual(candidate.mapping);
  expect(measured.candidates[0].evaluations[0].status).toBe('completed');
  expect(measured.candidates[0].evaluations[0].executedTicks).toBe(300);
  expect(measured.candidates[0].evaluations[0].simulationSeed).toBe(937);
  expect(measured.candidates[0].evaluations[0].traceUrl).toBeTruthy();
  expect(measured.costs.started + measured.costs.cacheHits).toBeGreaterThan(0);
  await page.getByRole('tab', { name: 'Run comparison', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Run A', exact: true })).toContainText(record.id);
  await expect(page.getByRole('region', { name: 'Run B', exact: true })).toContainText(measured.id);
  await expect(page.getByRole('button', { name: 'Play replay', exact: true })).toBeEnabled();
  await page
    .getByRole('combobox', { name: 'Demand and fleet condition' })
    .selectOption('sparse-300-uniform');
  await expect(
    page.getByText(
      'Fixed mapping test: allocation quotas from the original condition are retained.',
      { exact: false },
    ),
  ).toBeVisible();
  await page
    .getByRole('spinbutton', { name: 'Fixed-map evaluation horizon', exact: true })
    .fill('300');
  await page.getByRole('textbox', { name: 'Simulation seeds', exact: true }).fill('939');
  await page.getByRole('button', { name: 'Evaluate fixed mapping', exact: true }).click();
  await expect(
    page.getByText('Evaluation finished. Select a candidate to inspect its measured result.', {
      exact: true,
    }),
  ).toBeVisible({ timeout: 120_000 });
  const transferPending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export record', exact: true }).click();
  const transfer = await exported(await transferPending);
  expect(transfer.scenario.id).toBe('sparse-300-uniform');
  expect(transfer.scenario.constraintMode).toBe('fixed-mapping');
  expect(transfer.candidates[0].mapping).toEqual(measured.candidates[0].mapping);
  expect(transfer.candidates[0].evaluations[0].status).toBe('completed');
  await expect(
    page.getByText(
      'These runs use different demand or fleet conditions. Their difference is not an estimate of the mapping change alone.',
      { exact: true },
    ),
  ).toBeVisible();
  expect(transfer.optimizerSeed).toBeNull();
  await page.getByLabel('Import sorting study', { exact: true }).setInputFiles({
    name: 'measured-fixed-mapping.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(transfer)),
  });
  await expect(page.getByText('Imported record', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Mapping', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Selected candidate details' })).toContainText(
    transfer.candidates[0].throughput!.toFixed(4),
  );
  await expect(
    page.getByRole('button', { name: 'Evaluate fixed mapping', exact: true }),
  ).toBeDisabled();
});

test('the local optimization loop trains on completed calls and measures selected candidates', async ({
  page,
}) => {
  test.skip(!live, 'Requires the original simulator and model training service.');
  test.setTimeout(180_000);
  await page.goto('./#sorting');
  await expect(page.getByTestId('sorting-workspace')).toHaveAttribute('data-mode', 'live');
  await expect(
    page.getByRole('combobox', { name: 'Selected candidate', exact: true }),
  ).toBeVisible();
  await page.getByRole('combobox', { name: 'Mapping search method' }).selectOption('spatial_aux');
  await page.getByRole('spinbutton', { name: 'Mapping simulation budget' }).fill('6');
  await page.getByRole('spinbutton', { name: 'Mapping batch size' }).fill('2');
  await page.getByRole('spinbutton', { name: 'Mapping optimizer seed' }).fill('89');
  await page.getByRole('textbox', { name: 'Simulation seeds', exact: true }).fill('938');
  await page.getByRole('button', { name: 'Optimize for this condition', exact: false }).click();
  await expect(
    page.getByText('Evaluation finished. Select a candidate to inspect its measured result.', {
      exact: true,
    }),
  ).toBeVisible({ timeout: 150_000 });
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export record', exact: true }).click();
  const record = await exported(await pending);
  expect(record.method).toBe('spatial_aux');
  expect(record.regime).toBe('cold-start');
  expect(record.historyIds).toEqual([]);
  expect(record.optimizerSeed).toBe(89);
  expect(record.costs.started).toBe(6);
  expect(record.costs.completed).toBe(6);
  expect(record.costs.trainingSeconds).toBeGreaterThan(0);
  expect(
    record.candidates.some((candidate) => candidate.prediction && candidate.throughput != null),
  ).toBe(true);
  expect(
    record.candidates.every((candidate) =>
      candidate.evaluations.every(
        (evaluation) => evaluation.status === 'completed' && evaluation.simulationSeed === 938,
      ),
    ),
  ).toBe(true);
});
