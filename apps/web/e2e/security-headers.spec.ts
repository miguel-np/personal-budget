import { expect, test } from '@playwright/test';

const sections = [
  { route: '/', heading: 'Resumen financiero' },
  { route: '/movements', heading: 'Movimientos' },
  { route: '/accounts', heading: 'Cuentas' },
  { route: '/patrimony', heading: 'Patrimonio y documentos' },
  { route: '/reports', heading: 'Informes' },
  { route: '/budgets', heading: 'Presupuestos' },
  { route: '/planning', heading: 'Planificación' },
  { route: '/intelligence', heading: 'Inteligencia financiera' },
  { route: '/review', heading: 'Revisión financiera' },
  { route: '/goals', heading: 'Objetivos' },
  { route: '/assistant', heading: 'Asistente' },
  { route: '/settings', heading: 'Configuración' },
] as const;

test('production preview sends restrictive security headers and CSP across every application section', async ({ page, request }) => {
  const response = await request.get('/');
  expect(response.ok()).toBe(true);
  const headers = response.headers();
  const policy = headers['content-security-policy'] ?? '';

  for (const directive of [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "style-src-elem 'self'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
  ]) {
    expect(policy).toContain(directive);
  }
  expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
  expect(policy).not.toContain("style-src 'self' 'unsafe-inline'");
  expect(policy).not.toContain("'unsafe-eval'");
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(headers['permissions-policy']).toContain('camera=()');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  expect(headers['cross-origin-resource-policy']).toBe('same-origin');

  const policyErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /content security policy|violates the following directive|refused to (?:load|apply|execute)/i.test(message.text())) {
      policyErrors.push(message.text());
    }
  });

  for (const section of sections) {
    await page.goto(section.route);
    await expect(page.getByRole('heading', { name: section.heading, level: 1 })).toBeVisible();
  }

  expect(policyErrors, 'CSP violations while loading production routes').toEqual([]);
});
