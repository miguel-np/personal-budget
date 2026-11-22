import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateFileBudget, extractMarkdownLinks, extractNpmCommands, getImportBoundaryViolation } from './repository-checks.mjs';

test('extracts local Markdown links and ignores code examples and external URLs', () => {
  const markdown = [
    '[Guide](../docs/guide.md#setup)',
    '[External](https://example.com/path)',
    '[Email](mailto:team@example.com)',
    '~~~md',
    '[also not a link](missing-again.md)',
    '~~~',
  ].join('\n');
  assert.deepEqual(extractMarkdownLinks(markdown), ['../docs/guide.md#setup']);
});

test('enforces workspace dependency direction', () => {
  assert.match(getImportBoundaryViolation('packages/finance-core/src/domain.ts', '@personal-budget/actual-adapter') ?? '', /forbidden workspace boundary/u);
  assert.match(getImportBoundaryViolation('apps/web/src/App.tsx', '@actual-app/api') ?? '', /exclusively to services\/actual-adapter/u);
  assert.equal(getImportBoundaryViolation('services/api/src/app.ts', '@personal-budget/finance-core'), undefined);
  assert.equal(getImportBoundaryViolation('services/actual-adapter/src/adapter.ts', '@actual-app/api'), undefined);
});

test('applies file budgets to new files and prevents growth of inherited exceptions', () => {
  const withinBudget = Buffer.from('const value = 1;\n');
  const oversized = Buffer.from('x\n'.repeat(601));
  const slightlyLarger = Buffer.from('x\n'.repeat(602));
  assert.equal(evaluateFileBudget(null, withinBudget, 'new-file.ts'), undefined);
  assert.match(evaluateFileBudget(null, oversized, 'new-file.ts') ?? '', /new and exceeds/u);
  assert.equal(evaluateFileBudget(oversized, oversized, 'legacy.ts'), undefined);
  assert.match(evaluateFileBudget(oversized, slightlyLarger, 'legacy.ts') ?? '', /must not grow/u);
});

test('only validates npm commands shown as inline or fenced code', () => {
  const markdown = [
    'The phrase npm run explanatory is ordinary prose, not a command.',
    '`npm run lint` is an inline command.',
    '~~~bash',
    'npm run quality:repo',
    '~~~',
  ].join('\n');
  assert.deepEqual(extractNpmCommands(markdown), [
    { script: 'lint', suffix: '' },
    { script: 'quality:repo', suffix: '' },
  ]);
});
