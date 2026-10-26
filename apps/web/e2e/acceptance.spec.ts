import { expect, test } from '@playwright/test';
const fixtureApi = 'http://127.0.0.1:3000';

test.beforeEach(async ({ request }) => { await request.post(fixtureApi + '/__test__/reset'); });

test('dashboard loads synthetic finance figures and supports period changes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Resumen financiero' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cuentas incluidas' })).toBeVisible();
  const dashboardHeading = page.getByRole('heading', { name: 'Balance del periodo' });
  try {
    await expect(dashboardHeading).toBeVisible();
  } catch {
    const body = (await page.locator('body').innerText()).slice(0, 2_000);
    throw new Error('Dashboard did not reach its loaded state. Visible UI: ' + body + '; browser errors: ' + browserErrors.join(' | '));
  }
  await expect(page.getByRole('heading', { name: 'Gastos por categoría' }).first()).toBeVisible();
  await expect(page.locator('.stat-card').filter({ hasText: 'Ingresos clasificados en el periodo' }).getByText(/4250,00/)).toBeVisible();
  await page.getByRole('button', { name: 'Año' }).click();
  await expect(page.locator('input[type="number"]')).toBeVisible();
  await page.getByRole('button', { name: 'Mes' }).click();
  await expect(page.locator('input[type="month"]')).toBeVisible();
});

test('reports show current and previous period context', async ({ page }) => {
  await page.goto('/reports');
  await expect(page.getByRole('heading', { name: 'Informes del periodo' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Periodo actual y anterior' })).toBeVisible();
  await expect(page.getByText(/Anterior:/).first()).toBeVisible();
  await expect(page.locator('.comparison-row')).toHaveCount(3);
});

test('movement search, pagination and section navigation preserve filters', async ({ page }) => {
  await page.goto('/movements');
  await expect(page.getByRole('heading', { name: 'Transacciones' })).toBeVisible();
  await expect(page.getByText('Página 1 de 2')).toBeVisible();
  await page.getByRole('button', { name: 'Siguiente' }).click();
  await expect(page.getByText('Página 2 de 2')).toBeVisible();
  await page.getByRole('button', { name: 'Anterior' }).click();
  await page.getByLabel('Buscar').fill('Supermercado sintético');
  await expect(page.getByText('Supermercado sintético')).toBeVisible();
  await expect(page.getByText('Ingreso sintético')).toHaveCount(0);
  const navigation = page.getByRole('navigation', { name: 'Secciones de la aplicación' });
  await navigation.getByRole('link', { name: 'Resumen', exact: true }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Cuentas incluidas' })).toBeVisible();
  await navigation.getByRole('link', { name: 'Movimientos', exact: true }).click();
  await expect(page).toHaveURL('/movements');
  await expect(page.getByLabel('Buscar')).toHaveValue('Supermercado sintético');
  await expect(page.getByText('Supermercado sintético')).toBeVisible();
  await expect(page.getByText('Ingreso sintético')).toHaveCount(0);
});

test('CSV import requires preview and explicit confirmation; errors preserve entered data', async ({ page, request }) => {
  await page.goto('/movements');
  await page.getByRole('button', { name: 'Importar CSV' }).click();
  await page.getByLabel('Archivo CSV').setInputFiles({
    name: 'extracto-sintetico.csv', mimeType: 'text/csv',
    buffer: Buffer.from('date;description;amount\n2026-10-12;Movimiento sintético de prueba;12,50\n'),
  });
  await expect(page.getByText(/1 filas detectadas/)).toBeVisible();
  await page.locator('.csv-controls-top').getByLabel('Cuenta destino').selectOption('synthetic-account-1');
  await page.locator('.csv-controls-top').getByLabel('Formato de fecha').selectOption('iso');
  await page.locator('.csv-controls-top').getByLabel('Separador decimal').selectOption(',');
  await page.getByRole('button', { name: 'Validar y previsualizar' }).click();
  await expect(page.getByRole('cell', { name: 'Movimiento sintético de prueba' })).toBeVisible();
  expect((await (await request.get(fixtureApi + '/__test__/state')).json()).commitCount).toBe(0);
  await request.post(fixtureApi + '/__test__/mode', { data: { failImportPreview: true } });
  await page.getByRole('button', { name: 'Validar y previsualizar' }).click();
  await expect(page.getByRole('alert')).toContainText('previsualización sintética ha fallado');
  await expect(page.getByLabel('Archivo CSV')).toBeAttached();
  await expect(page.getByRole('button', { name: /Confirmar importación/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Confirmar importación/ })).toHaveCount(0);
  expect((await (await request.get(fixtureApi + '/__test__/state')).json()).commitCount).toBe(0);
  await request.post(fixtureApi + '/__test__/mode', { data: { failImportPreview: false } });
  await page.getByRole('button', { name: 'Validar y previsualizar' }).click();
  await page.getByRole('button', { name: 'Confirmar importación (1)' }).click();
  await expect(page.getByText(/Importación confirmada por Actual/)).toBeVisible();
  expect((await (await request.get(fixtureApi + '/__test__/state')).json()).commitCount).toBe(1);
});

test('budgets load and an allocation write is visible after refresh', async ({ page, request }) => {
  await page.goto('/budgets');
  await expect(page.getByRole('heading', { name: 'Presupuestos por categoría' })).toBeVisible();
  await expect(page.getByText('Alimentación sintética')).toBeVisible();
  await page.getByRole('button', { name: 'Editar asignación' }).click();
  await page.getByLabel('Nueva asignación para Alimentación sintética').fill('600,00');
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  const state = await (await request.get(fixtureApi + '/__test__/state')).json();
  expect(state.budgetedMinor).toBe(60000);
  await expect(page.locator('.budget-explainer').getByText(/Los cambios confirmados se guardan en Actual Budget/)).toBeVisible();
  await expect(page.getByRole('status')).toContainText(/Asignación actualizada en Actual Budget/);
});

test('category suggestions preview is read-only until confirmed; cancel is safe', async ({ page, request }) => {
  await page.goto('/planning');
  await expect(page.getByRole('heading', { name: 'Planificación', level: 2 })).toBeVisible();
  await expect(page.getByText('Cafetería sin categoría sintética')).toBeVisible();

  const category = page.getByLabel('Categoría').first();
  await category.selectOption('synthetic-restaurants');
  await expect(category).toHaveValue('synthetic-restaurants');
  await page.getByRole('button', { name: 'Previsualizar', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Confirmación de categorización' })).toBeVisible();
  await expect(category).toBeDisabled();

  let state = await (await request.get(fixtureApi + '/__test__/state')).json();
  expect(state.categoryWrites).toBe(0);
  expect(state.lastPreviewChanges).toEqual([{ transactionId: 'synthetic-tx-3', categoryId: 'synthetic-restaurants' }]);

  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  expect((await (await request.get(fixtureApi + '/__test__/state')).json()).categoryWrites).toBe(0);

  await page.getByRole('button', { name: 'Previsualizar', exact: true }).click();
  await page.getByRole('button', { name: 'Confirmar aplicación' }).click();
  await expect(page.locator('.planning-panel').getByRole('status')).toContainText('confirmación explícita');

  state = await (await request.get(fixtureApi + '/__test__/state')).json();
  expect(state.categoryWrites).toBe(1);
  expect(state.lastCommittedChanges).toEqual([{ transactionId: 'synthetic-tx-3', categoryId: 'synthetic-restaurants' }]);
});
test('discarding a category suggestion never sends a write', async ({ page, request }) => {
  await page.goto('/planning');
  await expect(page.getByText('Cafetería sin categoría sintética')).toBeVisible();
  await page.getByRole('button', { name: 'Descartar' }).click();
  await expect(page.getByText('Cafetería sin categoría sintética')).toHaveCount(0);
  expect((await (await request.get(fixtureApi + '/__test__/state')).json()).categoryWrites).toBe(0);
});

test('Actual not configured is actionable and the financial UI works without Ollama', async ({ page, request }) => {
  await request.post(fixtureApi + '/__test__/mode', { data: { readiness: 'not_configured' } });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Actual Budget aún no está conectado');
  await expect(page.getByRole('link', { name: 'Movimientos' })).toBeVisible();
  await request.post(fixtureApi + '/__test__/reset');
  await page.goto('/assistant');
  await expect(page.getByRole('heading', { name: 'Asistente financiero' })).toBeVisible();
  await expect(page.getByText('El asistente no está disponible')).toBeVisible();
});

test('global account scope persists and narrows the movements view', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Cuentas incluidas' })).toBeVisible();
  await page.getByLabel('Seleccionar cuentas').check();
  const chooser = page.getByRole('group', { name: 'Cuentas seleccionadas para análisis' });
  await chooser.getByRole('checkbox', { name: 'Cuenta sintética secundaria' }).check();
  await page.getByRole('button', { name: 'Guardar ámbito' }).click();
  await expect(page.getByText(/Cuentas seleccionadas: Cuenta sintética secundaria/)).toBeVisible();
  const state = await (await request.get(fixtureApi + '/__test__/state')).json();
  expect(state.accountScope).toEqual({ mode: 'selected', accountIds: ['synthetic-account-2'] });
  await page.getByRole('link', { name: 'Movimientos', exact: true }).click();
  await expect(page.getByText('Ingreso sintético')).toBeVisible();
  await expect(page.getByText('Supermercado sintético')).toHaveCount(0);
});

test('analysis currency preference persists and is applied to dashboard display', async ({ page, request }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Divisa de análisis y conversiones' })).toBeVisible();
  const currencyInput = page.getByLabel('Divisa de análisis (código ISO de 3 letras)');
  await currencyInput.fill('GBP');
  const saveCurrencyPreferences = page.locator('.currency-settings').getByRole('button', { name: 'Guardar preferencias', exact: true });
  await expect(saveCurrencyPreferences).toBeVisible();
  await saveCurrencyPreferences.click();
  await expect(page.locator('.currency-settings').getByRole('status')).toContainText('Preferencias monetarias guardadas localmente.');
  const state = await (await request.get(fixtureApi + '/__test__/state')).json();
  expect(state.currencyPreferences.displayCurrency).toBe('GBP');
  await page.goto('/');
  await expect(page.locator('.stat-card').filter({ hasText: 'Ingresos clasificados en el periodo' }).getByText(/GBP/)).toBeVisible();
});

test('desktop, tablet and mobile viewports avoid page-level horizontal overflow', async ({ page }) => {
  for (const width of [1440, 900, 390, 375]) {
    await page.setViewportSize({ width, height: 850 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Resumen financiero' })).toBeVisible();
    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      page: document.documentElement.scrollWidth,
      offenders: [...document.querySelectorAll('*')].map((element) => {
        const rect = element.getBoundingClientRect();
        const html = element;
        return {
          tag: html.tagName.toLowerCase(),
          className: typeof html.className === 'string' ? html.className.slice(0, 100) : '',
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          scrollWidth: html.scrollWidth,
        };
      }).filter((entry) => entry.right > window.innerWidth + 1 && entry.width > 0)
        .sort((a, b) => b.right - a.right).slice(0, 10),
    }));
    expect(dimensions.page, 'page horizontal overflow at viewport ' + width + ': ' + JSON.stringify(dimensions.offenders)).toBeLessThanOrEqual(dimensions.viewport + 1);
  }
});
