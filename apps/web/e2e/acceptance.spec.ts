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
  await expect(page.locator('.movement-operation-notice')).toContainText('Importación confirmada por Actual');
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
  await expect(page.getByText(/Asignación actualizada en Actual Budget/)).toBeVisible();
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

test('skip navigation and section changes keep keyboard focus predictable', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');

  const skipLink = page.getByRole('link', { name: 'Saltar al contenido principal' });
  await page.keyboard.press('Tab');
  await expect(skipLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();

  await page.getByRole('navigation', { name: 'Secciones de la aplicación' })
    .getByRole('link', { name: 'Movimientos', exact: true }).click();
  await expect(page).toHaveURL('/movements');
  await expect(page.getByRole('heading', { name: 'Movimientos', level: 1 })).toBeFocused();
});

test('visible form controls have programmatic labels across core sections', async ({ page }) => {
  for (const route of ['/', '/movements', '/reports', '/budgets', '/planning', '/assistant', '/settings']) {
    await page.goto(route);
    await expect(page.getByRole('main')).toBeVisible();
    const unlabeled = await page.locator('input:not([type="hidden"]), select, textarea').evaluateAll((elements) => {
      const textForId = (id: string) => document.getElementById(id)?.textContent?.trim() ?? '';
      return elements
        .filter((element) => element instanceof HTMLElement && element.getClientRects().length > 0)
        .filter((element) => {
          const ariaLabel = element.getAttribute('aria-label')?.trim() ?? '';
          const labelledBy = (element.getAttribute('aria-labelledby') ?? '')
            .split(/\s+/).filter(Boolean).some((id) => textForId(id).length > 0);
          const labels = 'labels' in element
            ? Array.from((element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).labels ?? [])
                .some((label) => label.textContent?.trim())
            : false;
          return !ariaLabel && !labelledBy && !labels;
        })
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          type: element.getAttribute('type'),
          id: element.id,
          name: element.getAttribute('name'),
          placeholder: element.getAttribute('placeholder'),
        }));
    });
    expect(unlabeled, 'Unlabeled visible controls at ' + route).toEqual([]);
  }
});

test('key financial text meets WCAG AA contrast against its rendered surface', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.stat-card').first()).toBeVisible();
  const lowContrast = await page.evaluate(() => {
    type RGBA = [number, number, number, number];
    const parseColor = (value: string): RGBA | null => {
      const channels = value.match(/[\d.]+/g)?.map(Number);
      if (!channels || channels.length < 3) return null;
      return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0, channels[3] ?? 1];
    };
    const luminance = (color: RGBA): number => {
      const channel = (value: number) => {
        const srgb = value / 255;
        return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2]);
    };
    const ratio = (foreground: RGBA, background: RGBA) => {
      const a = luminance(foreground);
      const b = luminance(background);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const selectors = [
      '.page-header h1', '.page-subtitle', '.stat-card > p', '.stat-card > strong',
      '.stat-card > span', '.app-footer', '.muted-copy', '.section-footnote', '.field-label',
    ];
    return selectors.flatMap((selector) => [...document.querySelectorAll(selector)]
      .filter((element) => element.getClientRects().length > 0 && (element.textContent ?? '').trim().length > 0)
      .map((element) => {
        const style = getComputedStyle(element);
        const foreground = parseColor(style.color);
        let ancestor: Element | null = element;
        let background: RGBA | null = null;
        while (ancestor) {
          const parsed = parseColor(getComputedStyle(ancestor).backgroundColor);
          if (parsed && parsed[3] >= 0.99) { background = parsed; break; }
          ancestor = ancestor.parentElement;
        }
        const contrast = foreground && background ? ratio(foreground, background) : 0;
        return { selector, text: (element.textContent ?? '').trim().slice(0, 60), contrast: Number(contrast.toFixed(2)) };
      }).filter((sample) => sample.contrast < 4.5));
  });
  expect(lowContrast, 'Text that fails the WCAG AA contrast threshold: ' + JSON.stringify(lowContrast)).toEqual([]);
});

test('core sections reflow at desktop, tablet and mobile widths without page-level overflow', async ({ page }) => {
  const sections = [
    { route: '/', heading: 'Resumen financiero' },
    { route: '/movements', heading: 'Movimientos' },
    { route: '/reports', heading: 'Informes' },
    { route: '/budgets', heading: 'Presupuestos' },
    { route: '/planning', heading: 'Planificación' },
    { route: '/assistant', heading: 'Asistente' },
    { route: '/settings', heading: 'Configuración' },
  ];
  for (const width of [1440, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    for (const section of sections) {
      await page.goto(section.route);
      await expect(page.getByRole('heading', { name: section.heading, level: 1 })).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
        offenders: [...document.querySelectorAll('*')].map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            tag: element.tagName.toLowerCase(),
            className: typeof element.className === 'string' ? element.className.slice(0, 80) : '',
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
            scrollWidth: element.scrollWidth,
          };
        }).filter((element) => element.right > window.innerWidth + 1 && element.width > 0)
          .sort((a, b) => b.right - a.right).slice(0, 8),
      }));
      expect(dimensions.document, 'Page overflow at ' + section.route + ' / ' + width + 'px: ' + JSON.stringify(dimensions.offenders)).toBeLessThanOrEqual(dimensions.viewport + 1);
    }
  }
});

test('primary actions expose comfortable touch target sizes on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/movements');
  const undersized = await page.locator('.button, .nav-item, .mode-button, .pagination button')
    .evaluateAll((elements) => elements
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => ({
        selector: element.className.toString(),
        label: (element.textContent ?? '').trim().slice(0, 40),
        width: Math.round(element.getBoundingClientRect().width),
        height: Math.round(element.getBoundingClientRect().height),
      }))
      .filter((element) => element.height < 44 || element.width < 44));
  expect(undersized, 'Action targets below the 44px design target: ' + JSON.stringify(undersized)).toEqual([]);
});


test('movement editor previews validated changes before writing to Actual', async ({ page, request }) => {
  await page.goto('/movements');
  await expect(page.getByRole('heading', { name: 'Transacciones' })).toBeVisible();
  await page.getByRole('button', { name: 'Editar' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Revisar cambios' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cerrar' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Previsualizar cambios' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Cerrar' })).toBeFocused();
  await dialog.getByLabel('Importe (unidades principales)').fill('-30,00');
  await dialog.getByRole('button', { name: 'Previsualizar cambios' }).click();
  await expect(dialog.getByText(/Previsualización — todavía sin guardar/)).toBeVisible();
  expect((await (await request.get(fixtureApi + '/__test__/state')).json()).transactionWrites).toBe(0);
  await dialog.getByRole('button', { name: 'Confirmar y guardar' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.movement-operation-notice')).toContainText('Cambios validados y verificados en Actual Budget');
  const state = await (await request.get(fixtureApi + '/__test__/state')).json();
  expect(state.transactionWrites).toBe(1);
  expect(state.lastTransactionUpdate).toMatchObject({
    transactionId: 'synthetic-tx-1',
    fields: ['amount'],
    changes: { amount: -3000 },
  });
});

test('editing a linked transfer verifies both legs and rejects reversing its direction', async ({ page, request }) => {
  await request.post(fixtureApi + '/__test__/reset');
  await page.goto('/movements');
  const sourceRow = page.locator('.transactions-table tbody tr')
    .filter({ hasText: 'Transferencia sintética' })
    .filter({ has: page.locator('.amount-cell.expense') })
    .first();
  await expect(sourceRow).toBeVisible();
  await sourceRow.getByRole('button', { name: 'Editar' }).click();
  const dialog = page.getByRole('dialog', { name: 'Revisar cambios' });
  await dialog.getByLabel('Importe (unidades principales)').fill('-60,00');
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateValue = yesterday.getFullYear() + '-' + String(yesterday.getMonth() + 1).padStart(2, '0') + '-' + String(yesterday.getDate()).padStart(2, '0');
  await dialog.getByRole('textbox', { name: 'Fecha' }).fill(dateValue);
  await dialog.getByRole('checkbox', { name: /Sincronizar también la fecha con la otra cuenta/ }).check();
  await dialog.getByRole('button', { name: 'Previsualizar cambios' }).click();
  expect((await (await request.get(fixtureApi + '/__test__/state')).json()).transactionWrites).toBe(0);
  await dialog.getByRole('button', { name: 'Confirmar y guardar' }).click();
  await expect(page.locator('.movement-operation-notice')).toContainText('Transferencia actualizada y verificada');
  const state = await (await request.get(fixtureApi + '/__test__/state')).json();
  expect(state.transactionWrites).toBe(2);
  expect(state.transferState.source).toMatchObject({ date: dateValue, amount: -6_000, transfer_id: 'synthetic-transfer-counterpart' });
  expect(state.transferState.counterpart).toMatchObject({ date: dateValue, amount: 6_000, transfer_id: 'synthetic-transfer-source' });
  expect(state.transferState.source.amount + state.transferState.counterpart.amount).toBe(0);

  await page.reload();
  const updatedSource = page.locator('.transactions-table tbody tr')
    .filter({ hasText: 'Transferencia sintética' })
    .filter({ has: page.locator('.amount-cell.expense') })
    .first();
  await updatedSource.getByRole('button', { name: 'Editar' }).click();
  const reverseDialog = page.getByRole('dialog', { name: 'Revisar cambios' });
  await reverseDialog.getByLabel('Importe (unidades principales)').fill('60,00');
  await reverseDialog.getByRole('button', { name: 'Previsualizar cambios' }).click();
  await expect(reverseDialog.getByRole('alert')).toContainText('No se puede invertir la dirección');
  expect((await (await request.get(fixtureApi + '/__test__/state')).json()).transactionWrites).toBe(2);
});

test('editing a linked transfer date keeps the other date unless explicitly synchronized', async ({ page, request }) => {
  await request.post(fixtureApi + '/__test__/reset');
  await page.goto('/movements');
  const initialState = await (await request.get(fixtureApi + '/__test__/state')).json();
  const counterpartDate = initialState.transferState.counterpart.date;
  const sourceRow = page.locator('.transactions-table tbody tr')
    .filter({ hasText: 'Transferencia sintética' })
    .filter({ has: page.locator('.amount-cell.expense') })
    .first();
  await sourceRow.getByRole('button', { name: 'Editar' }).click();
  const dialog = page.getByRole('dialog', { name: 'Revisar cambios' });
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateValue = yesterday.getFullYear() + '-' + String(yesterday.getMonth() + 1).padStart(2, '0') + '-' + String(yesterday.getDate()).padStart(2, '0');
  const syncDate = dialog.getByRole('checkbox', { name: /Sincronizar también la fecha con la otra cuenta/ });
  await expect(syncDate).not.toBeChecked();
  await dialog.getByRole('textbox', { name: 'Fecha' }).fill(dateValue);
  await expect(syncDate).toBeEnabled();
  await dialog.getByRole('button', { name: 'Previsualizar cambios' }).click();
  expect((await (await request.get(fixtureApi + '/__test__/state')).json()).transactionWrites).toBe(0);
  await dialog.getByRole('button', { name: 'Confirmar y guardar' }).click();

  await expect(page.locator('.movement-operation-notice'))
    .toContainText('La fecha solo se ha cambiado en esta cuenta; la otra conserva su fecha.');
  const state = await (await request.get(fixtureApi + '/__test__/state')).json();
  expect(state.transactionWrites).toBe(1);
  expect(state.transferState.source.date).toBe(dateValue);
  expect(state.transferState.counterpart.date).toBe(counterpartDate);
});

test('editing notes on a linked transfer synchronizes and verifies both legs', async ({ page, request }) => {
  await request.post(fixtureApi + '/__test__/reset');
  await page.goto('/movements');
  const sourceRow = page.locator('.transactions-table tbody tr')
    .filter({ hasText: 'Transferencia sintética' })
    .filter({ has: page.locator('.amount-cell.expense') })
    .first();
  await expect(sourceRow).toBeVisible();
  await sourceRow.getByRole('button', { name: 'Editar' }).click();
  const dialog = page.getByRole('dialog', { name: 'Revisar cambios' });
  await dialog.getByLabel('Notas').fill('Nota sincronizada');
  await dialog.getByRole('button', { name: 'Previsualizar cambios' }).click();
  expect((await (await request.get(fixtureApi + '/__test__/state')).json()).transactionWrites).toBe(0);
  await dialog.getByRole('button', { name: 'Confirmar y guardar' }).click();

  await expect(page.locator('.movement-operation-notice'))
    .toContainText('Las notas se han sincronizado y verificado en ambas partes.');
  const state = await (await request.get(fixtureApi + '/__test__/state')).json();
  expect(state.transactionWrites).toBe(2);
  expect(state.transferState.source.notes).toBe('Nota sincronizada');
  expect(state.transferState.counterpart.notes).toBe('Nota sincronizada');
});

test('editing a split child preserves every part and recalculates the parent total', async ({ page, request }) => {
  await request.post(fixtureApi + '/__test__/reset');
  await page.goto('/movements');
  const splitRow = page.locator('.transactions-table tbody tr').filter({ hasText: 'Parte alimentación' }).first();
  await expect(splitRow).toBeVisible();
  await splitRow.getByRole('button', { name: 'Editar' }).click();
  const dialog = page.getByRole('dialog', { name: 'Revisar cambios' });
  await expect(dialog.getByText(/Esta parte se guarda reenviando el desglose completo/)).toBeVisible();
  await dialog.getByLabel('Importe (unidades principales)').fill('-35,00');
  await dialog.getByRole('button', { name: 'Previsualizar cambios' }).click();
  expect((await (await request.get(fixtureApi + '/__test__/state')).json()).transactionWrites).toBe(0);
  await dialog.getByRole('button', { name: 'Confirmar y guardar' }).click();
  await expect(page.locator('.movement-operation-notice')).toContainText('Parte del desglose actualizada');
  const state = await (await request.get(fixtureApi + '/__test__/state')).json();
  expect(state.transactionWrites).toBe(1);
  expect(state.splitState.parentAmount).toBe(-7_500);
  expect(state.splitState.children.map((child: { id: string }) => child.id)).toEqual(['synthetic-split-food', 'synthetic-split-other']);
  expect(state.splitState.children.map((child: { amount: number }) => child.amount)).toEqual([-3_500, -4_000]);
  expect(state.splitState.children.reduce((sum: number, child: { amount: number }) => sum + child.amount, 0)).toBe(state.splitState.parentAmount);
});

test('bulk categorization previews all eligible rows and confirms a reported outcome', async ({ page, request }) => {
  await page.goto('/movements');
  await page.getByRole('checkbox', { name: 'Seleccionar Supermercado sintético' }).check();
  await page.getByLabel('Categoría de gasto para el lote').selectOption('synthetic-restaurants');
  await page.getByRole('button', { name: 'Previsualizar lote' }).click();
  await expect(page.locator('.movement-actions-toolbar').getByRole('status')).toContainText('todavía no se ha modificado ningún movimiento');
  expect((await (await request.get(fixtureApi + '/__test__/state')).json()).categoryWrites).toBe(0);
  page.once('dialog', (dialog) => { void dialog.accept(); });
  await page.getByRole('button', { name: 'Confirmar lote' }).click();
  await expect(page.locator('.movement-operation-notice')).toContainText('Se ha confirmado la categoría de 1 movimiento en Actual Budget');
  const state = await (await request.get(fixtureApi + '/__test__/state')).json();
  expect(state.categoryWrites).toBe(1);
  expect(state.lastCommittedChanges).toEqual([{ transactionId: 'synthetic-tx-1', categoryId: 'synthetic-restaurants' }]);
});

test('bulk category commit rejects a stale preview and requires a refreshed baseline', async ({ page, request }) => {
  await request.post(fixtureApi + '/__test__/reset');
  await page.goto('/movements');
  const rowCheckbox = page.getByRole('checkbox', { name: 'Seleccionar Supermercado sintético' });
  await rowCheckbox.check();
  await page.getByLabel('Categoría de gasto para el lote').selectOption('synthetic-restaurants');
  await page.getByRole('button', { name: 'Previsualizar lote' }).click();
  await expect(page.locator('.movement-actions-toolbar').getByRole('status')).toContainText('Se comprobará que sus categorías no cambien');
  expect((await (await request.get(fixtureApi + '/__test__/state')).json()).categoryWrites).toBe(0);

  await request.post(fixtureApi + '/__test__/change-category', {
    data: { transactionId: 'synthetic-tx-1', categoryId: 'synthetic-restaurants' },
  });
  page.once('dialog', (dialog) => { void dialog.accept(); });
  await page.getByRole('button', { name: 'Confirmar lote' }).click();
  await expect(page.locator('.movement-actions-toolbar').getByRole('alert')).toContainText('La categoría cambió después de la previsualización');
  expect(await rowCheckbox.isChecked()).toBe(true);
  expect((await (await request.get(fixtureApi + '/__test__/state')).json()).categoryWrites).toBe(0);

  await page.getByRole('button', { name: 'Previsualizar lote' }).click();
  page.once('dialog', (dialog) => { void dialog.accept(); });
  await page.getByRole('button', { name: 'Confirmar lote' }).click();
  await expect(page.locator('.movement-operation-notice')).toContainText('Se ha confirmado la categoría de 1 movimiento');
  const state = await (await request.get(fixtureApi + '/__test__/state')).json();
  expect(state.categoryWrites).toBe(0); // the concurrent change already satisfied the requested final state
  expect(state.lastCommittedChanges).toEqual([{ transactionId: 'synthetic-tx-1', categoryId: 'synthetic-restaurants' }]);
});

test('bulk category partial result keeps only pending rows selected for a fresh retry', async ({ page, request }) => {
  await request.post(fixtureApi + '/__test__/reset');
  await page.goto('/movements');
  const first = page.getByRole('checkbox', { name: 'Seleccionar Supermercado sintético' });
  const second = page.getByRole('checkbox', { name: 'Seleccionar Cafetería sin categoría sintética' });
  await first.check();
  await second.check();
  await page.getByLabel('Categoría de gasto para el lote').selectOption('synthetic-restaurants');
  await page.getByRole('button', { name: 'Previsualizar lote' }).click();
  await request.post(fixtureApi + '/__test__/mode', { data: { batchFailAtTransactionId: 'synthetic-tx-3' } });
  page.once('dialog', (dialog) => { void dialog.accept(); });
  await page.getByRole('button', { name: 'Confirmar lote' }).click();

  await expect(page.locator('.movement-actions-toolbar').getByRole('status')).toContainText('Solo quedan seleccionados los movimientos pendientes');
  expect(await first.isChecked()).toBe(false);
  expect(await second.isChecked()).toBe(true);
  let state = await (await request.get(fixtureApi + '/__test__/state')).json();
  expect(state.categoryWrites).toBe(1);
  expect(state.lastCommittedChanges).toEqual([{ transactionId: 'synthetic-tx-1', categoryId: 'synthetic-restaurants' }]);

  await page.getByRole('button', { name: 'Previsualizar lote' }).click();
  await expect(page.locator('.movement-actions-toolbar').getByRole('status')).toContainText('1 movimientos de gasto');
  page.once('dialog', (dialog) => { void dialog.accept(); });
  await page.getByRole('button', { name: 'Confirmar lote' }).click();
  await expect(page.locator('.movement-operation-notice')).toContainText('Se ha confirmado la categoría de 1 movimiento');
  state = await (await request.get(fixtureApi + '/__test__/state')).json();
  expect(state.categoryWrites).toBe(2);
  expect(state.lastCommittedChanges).toEqual([{ transactionId: 'synthetic-tx-3', categoryId: 'synthetic-restaurants' }]);
});

test('movement export previews all filtered rows before downloading CSV or JSON', async ({ page }) => {
  await page.goto('/movements');
  await page.getByLabel('Buscar').fill('Supermercado sintético');
  await expect(page.getByText('Supermercado sintético')).toBeVisible();
  await page.getByRole('button', { name: 'Preparar exportación' }).click();
  const preview = page.getByRole('region', { name: 'Previsualización de exportación de movimientos' });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('1 movimiento');
  await expect(preview).toContainText('Todas las categorías');

  const csvPromise = page.waitForEvent('download');
  await preview.getByRole('button', { name: 'Descargar CSV' }).click();
  const csvDownload = await csvPromise;
  expect(csvDownload.suggestedFilename()).toMatch(/^movimientos-filtrados-\d{4}-\d{2}-\d{2}\.csv$/);
  await expect(page.locator('.movement-manager').getByRole('status')).toContainText('Descarga iniciada');

  const jsonPromise = page.waitForEvent('download');
  await preview.getByRole('button', { name: 'Descargar JSON' }).click();
  const jsonDownload = await jsonPromise;
  expect(jsonDownload.suggestedFilename()).toMatch(/^movimientos-filtrados-\d{4}-\d{2}-\d{2}\.json$/);
});

test('report export previews period, account scope and analysis currency before download', async ({ page }) => {
  await page.goto('/reports');
  const exportPanel = page.getByRole('region', { name: 'Exportación de informes' });
  await expect(exportPanel).toBeVisible();
  await exportPanel.getByRole('button', { name: 'Preparar exportación del informe' }).click();
  const preview = page.getByRole('region', { name: 'Previsualización de exportación del informe' });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('Periodo actual');
  await expect(preview).toContainText('Divisa de análisis');
  await expect(preview).toContainText('Importes agregados calculados');

  const csvPromise = page.waitForEvent('download');
  await preview.getByRole('button', { name: 'Descargar informe CSV' }).click();
  const csvDownload = await csvPromise;
  expect(csvDownload.suggestedFilename()).toMatch(/^informe-financiero-\d{4}-\d{2}-\d{2}\.csv$/);

  const jsonPromise = page.waitForEvent('download');
  await preview.getByRole('button', { name: 'Descargar informe JSON' }).click();
  const jsonDownload = await jsonPromise;
  expect(jsonDownload.suggestedFilename()).toMatch(/^informe-financiero-\d{4}-\d{2}-\d{2}\.json$/);
});

test('settings persist theme and regional formatting and reset only local preferences', async ({ page, request }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Centro de configuración' })).toBeVisible();
  await page.getByLabel('Tema').selectOption('light');
  await page.getByLabel('Formato de fechas e importes').selectOption('en-GB');
  await page.getByRole('button', { name: 'Guardar preferencias de interfaz' }).click();
  await expect(page.locator('.settings-center').getByRole('status')).toContainText('Preferencias de interfaz guardadas localmente');
  await expect.poll(async () => {
    const state = await (await request.get(fixtureApi + '/__test__/state')).json();
    return state.appPreferences;
  }).toEqual({ theme: 'light', locale: 'en-GB' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-GB');

  page.once('dialog', (dialog) => { void dialog.accept(); });
  await page.getByRole('button', { name: 'Restablecer preferencias locales' }).click();
  await expect(page.locator('.settings-center').getByRole('status').filter({ hasText: 'Preferencias locales restablecidas' })).toBeVisible();
  await expect.poll(async () => {
    const state = await (await request.get(fixtureApi + '/__test__/state')).json();
    return state.appPreferences;
  }).toEqual({ theme: 'system', locale: 'es-ES' });
  const finalState = await (await request.get(fixtureApi + '/__test__/state')).json();
  expect(finalState.currencyPreferences.displayCurrency).toBe('EUR');
  expect(finalState.accountScope).toEqual({ mode: 'all', accountIds: [] });
});
