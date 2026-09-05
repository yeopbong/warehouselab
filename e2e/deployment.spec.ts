import { expect, test } from '@playwright/test';

test('published path loads assets and both workers and remains usable after refresh', async ({
  page,
  baseURL,
}) => {
  const root = new URL(baseURL!);
  const workers: string[] = [];
  const failures: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
  });
  page.on('requestfailed', (request) => {
    failures.push(`${request.failure()?.errorText} ${request.url()}`);
  });

  for (let visit = 0; visit < 2; visit++) {
    const response = visit === 0 ? await page.goto('./') : await page.reload();
    expect(response?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe(root.pathname);
    await expect(page.getByTestId('workbench')).toHaveAttribute('data-busy', 'false');
    await expect(page.getByTestId('state-digest')).toHaveAttribute('data-digest', /\S+/);
    await expect.poll(() => workers.length).toBe((visit + 1) * 2);
    await page.getByRole('button', { name: 'Step +1', exact: true }).click();
    await expect(page.getByTestId('tick')).toHaveText('1');
    await page.getByRole('tab', { name: 'Optimize', exact: true }).click();
    await page.getByRole('spinbutton', { name: 'Simulation budget', exact: true }).fill('2');
    await page.getByRole('spinbutton', { name: 'Evaluation horizon', exact: true }).fill('24');
    await page.getByTestId('start-search').click();
    await expect(page.getByTestId('search-progress')).toContainText('2 / 2 simulations');
    await expect(page.getByTestId('start-search')).toBeEnabled();
    await expect(page.getByTestId('load-best')).toBeEnabled();
  }

  const assets = await page
    .locator('script[src], link[rel="stylesheet"]')
    .evaluateAll((elements) =>
      elements.map((element) =>
        element instanceof HTMLScriptElement ? element.src : (element as HTMLLinkElement).href,
      ),
    );
  expect(assets.length).toBeGreaterThanOrEqual(2);
  for (const address of [...assets, ...workers]) {
    const url = new URL(address);
    expect(url.origin).toBe(root.origin);
    expect(url.pathname.startsWith(`${root.pathname}assets/`)).toBe(true);
  }
  expect(workers.filter((url) => url.includes('simulation.worker'))).toHaveLength(2);
  expect(workers.filter((url) => url.includes('search.worker'))).toHaveLength(2);
  expect(failures).toEqual([]);
});
