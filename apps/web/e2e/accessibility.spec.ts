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

test('critical application sections retain basic accessible semantics', async ({ page }) => {
  for (const section of sections) {
    await page.goto(section.route);
    await expect(page.getByRole('heading', { name: section.heading, level: 1 })).toBeVisible();
    const audit = await page.evaluate(() => {
      const visible = (element: Element): boolean => {
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
      };
      const textOf = (element: Element | null): string => element?.textContent?.trim() ?? '';
      const controls = Array.from(document.querySelectorAll(
        'button, [role="button"], a[href], [role="link"], input:not([type="hidden"]), select, textarea',
      )).filter(visible);
      const unnamed = controls.filter((element) => {
        if (element.getAttribute('aria-hidden') === 'true') return false;
        const labelledBy = element.getAttribute('aria-labelledby')?.split(/\\s+/u)
          .map((id) => textOf(document.getElementById(id))).join(' ').trim();
        const nativeLabels = 'labels' in element
          ? Array.from((element as HTMLInputElement).labels ?? []).map(textOf).join(' ').trim()
          : '';
        const accessibleName = element.getAttribute('aria-label')?.trim()
          || labelledBy || nativeLabels || textOf(element) || element.getAttribute('title')?.trim() || '';
        return accessibleName.length === 0;
      }).map((element) => element.tagName.toLowerCase() + (element.getAttribute('type') ? '[type=' + element.getAttribute('type') + ']' : ''));
      const imagesWithoutAlt = Array.from(document.querySelectorAll('img:not([alt])'))
        .filter(visible).map((element) => element.getAttribute('src') ?? '(unknown source)');
      return {
        language: document.documentElement.getAttribute('lang')?.trim() ?? '',
        mainLandmarks: document.querySelectorAll('main, [role="main"]').length,
        unnamed,
        imagesWithoutAlt,
      };
    });
    expect(audit.language, section.route + ' must declare the document language').not.toBe('');
    expect(audit.mainLandmarks, section.route + ' must expose one main landmark').toBe(1);
    expect(audit.unnamed, section.route + ' has unnamed interactive controls').toEqual([]);
    expect(audit.imagesWithoutAlt, section.route + ' has images without alt text').toEqual([]);
  }
});

test('keyboard users can reach a visible control with a visible focus indicator', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  const focused = page.locator(':focus');
  await expect(focused).toBeVisible();
  const outlineWidth = await focused.evaluate((element) => getComputedStyle(element).outlineWidth);
  const outlineStyle = await focused.evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(parseFloat(outlineWidth), 'focused control must have a visible outline').toBeGreaterThan(0);
  expect(outlineStyle).not.toBe('none');
});
