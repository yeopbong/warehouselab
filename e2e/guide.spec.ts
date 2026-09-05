import { expect, test } from '@playwright/test';

test('usage help provides practical links without resetting the current simulation', async ({
  page,
}) => {
  await page.goto('./');
  await expect(page.getByTestId('workbench')).toHaveAttribute('data-busy', 'false');
  await page.getByRole('button', { name: 'Step +1', exact: true }).click();
  await expect(page.getByTestId('tick')).toHaveText('1');
  const digest = await page.getByTestId('state-digest').getAttribute('data-digest');
  await page.getByRole('button', { name: 'About and diagnostics', exact: true }).click();
  const help = page.getByRole('region', { name: 'about', exact: true });
  await expect(help.getByRole('heading', { name: 'Using WarehouseLab', exact: true })).toBeVisible();
  await expect(help.getByRole('link', { name: 'Usage guide', exact: true })).toHaveAttribute(
    'href',
    'https://github.com/yeopbong/warehouselab/blob/main/docs/usage.md',
  );
  await expect(help.getByRole('link', { name: 'Recorded results', exact: true })).toHaveAttribute(
    'href',
    'https://github.com/yeopbong/warehouselab/blob/main/docs/validation.md',
  );
  await help.getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(page.getByTestId('tick')).toHaveText('1');
  await expect(page.getByTestId('state-digest')).toHaveAttribute('data-digest', digest!);
});

test('search explains budget and method choices and identifies supplied preset results', async ({
  page,
}) => {
  await page.goto('./');
  await expect(page.getByTestId('workbench')).toHaveAttribute('data-busy', 'false');
  await page.getByRole('tab', { name: 'Optimize', exact: true }).click();
  const budget = page.getByRole('spinbutton', { name: 'Simulation budget', exact: true });
  const method = page.getByRole('combobox', { name: 'Search method', exact: true });
  const scope = page.getByRole('combobox', { name: 'Search scope', exact: true });
  await expect(budget).toHaveValue('6');
  await expect(page.getByTestId('search-budget-hint')).toHaveCount(0);
  await expect(page.getByTestId('search-method-help')).toContainText('selects better-scoring');
  await scope.selectOption('benchmark-set');
  await expect(page.getByTestId('search-budget-hint')).toContainText('9 simulations');
  await scope.selectOption('current-factory');
  await budget.fill('2');
  await expect(page.getByTestId('search-budget-hint')).toContainText('3 simulations');
  await method.selectOption('random');
  await expect(page.getByTestId('search-budget-hint')).toHaveCount(0);
  await expect(page.getByTestId('search-method-help')).toContainText('independently');
  await method.selectOption('ga');
  await page.getByRole('spinbutton', { name: 'Evaluation horizon', exact: true }).fill('24');
  await page.getByTestId('start-search').click();
  await expect(page.getByTestId('search-progress')).toContainText('2 / 2 simulations');
  await expect(page.getByTestId('start-search')).toBeEnabled();
  await expect(page.getByTestId('best-origin')).toHaveText(
    /Recorded search best: supplied (Baseline|Queue aware) preset\./,
  );
  await expect(page.getByTestId('candidate-origin')).toContainText('Candidate from Open floor');
  await page.getByRole('button', { name: 'Compare baseline vs candidate', exact: true }).click();
  await expect(page.getByTestId('comparison')).toContainText('completed · 24 ticks · Open floor');
  await expect(page.getByTestId('comparison').getByRole('columnheader')).toHaveText([
    'Metric',
    'Baseline',
    'Candidate',
  ]);
});
