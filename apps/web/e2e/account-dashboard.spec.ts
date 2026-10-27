import { expect, test } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('http://127.0.0.1:3000/__test__/reset');
});

test('account view audits balances and opens movements in the selected account', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Señales accionables' })).toBeVisible();

  await page.getByRole('link', { name: /Cuentas/ }).click();
  await expect(page.getByRole('heading', { name: 'Cuentas y saldos' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cuenta sintética', exact: true })).toBeVisible();
  await expect(page.getByText('Patrimonio neto', { exact: true })).toBeVisible();
  await expect(page.getByText('No disponible', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('No se infiere una deuda a partir de un saldo negativo', { exact: false })).toBeVisible();
  await expect(page.getByText('Saldo actual', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Ver movimientos' }).first().click();
  await expect(page.getByRole('heading', { name: 'Transacciones' })).toBeVisible();
  await expect(page.getByLabel('Cuenta', { exact: true })).toHaveValue('synthetic-account-1');
});

test('dashboard shortcuts preserve transfer preview and signed manual movement validation', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Acciones rápidas' })).toBeVisible();

  await expect(page.getByRole('button', { name: 'Registrar transferencia' })).toBeEnabled();
  await page.getByRole('button', { name: 'Registrar transferencia' }).click();
  await expect(page.getByRole('heading', { name: 'Entre cuentas de Actual Budget' })).toBeVisible();
  await page.getByLabel('Importe positivo (EUR)').fill('125,00');
  await page.getByRole('button', { name: 'Previsualizar transferencia' }).click();
  await expect(page.getByRole('button', { name: 'Confirmar transferencia' })).toBeVisible();
  let transferState = await (await request.get('http://127.0.0.1:3000/__test__/state')).json();
  expect(transferState.transferPreviewCount).toBe(1);
  expect(transferState.transferCommitCount).toBe(0);
  await page.getByRole('button', { name: 'Confirmar transferencia' }).click();
  await expect(page.getByText(/Actual ha confirmado la operación/)).toBeVisible();
  transferState = await (await request.get('http://127.0.0.1:3000/__test__/state')).json();
  expect(transferState.transferCommitCount).toBe(1);
  expect(transferState.lastTransferPayload).toMatchObject({ sourceAccountId: 'synthetic-account-1', destinationAccountId: 'synthetic-account-transfer-eur', amountMinor: 12500 });

  await page.getByRole('link', { name: /personal-budget, ir al resumen/ }).click();
  await page.getByRole('button', { name: 'Registrar gasto' }).click();
  await expect(page).toHaveURL(/\/movements$/);
  await expect(page.getByRole('heading', { name: 'Registrar gasto' })).toBeVisible();

  await page.getByLabel(/Importe \(EUR\)/).fill('12,50');
  await page.getByLabel('Concepto').fill('Gasto sintético');
  await page.getByRole('button', { name: 'Previsualizar' }).click();
  await expect(page.getByRole('alert')).toContainText('Para registrar un gasto, introduce un importe negativo.');

  await page.getByLabel(/Importe \(EUR\)/).fill('-12,50');
  await page.getByRole('button', { name: 'Previsualizar' }).click();
  await expect(page.getByText('Previsualización calculada. Actual no se ha modificado.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirmar y registrar' })).toBeVisible();

  const state = await (await request.get('http://127.0.0.1:3000/__test__/state')).json();
  expect(state.commitCount).toBe(0);
});

test('dashboard uses an explicit empty state when budget numbers do not raise alerts', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Límites que requieren atención' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sin alertas de límite' })).toBeVisible();
  await expect(page.locator('.signal-note').filter({ hasText: 'Las alertas se ordenan primero por exceso' })).toBeVisible();
});
