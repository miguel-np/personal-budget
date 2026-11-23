import assert from 'node:assert/strict';
import test from 'node:test';
import { buildComplexityLintArgs, evaluateFileBudget, extractMarkdownLinks, extractNpmCommands, getImportBoundaryViolation, getManifestBoundaryViolations } from './repository-checks.mjs';

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
  assert.deepEqual(extractNpmCommands(markdown).sort((left, right) => left.script.localeCompare(right.script)), [
    { script: 'lint', suffix: '' },
    { script: 'quality:repo', suffix: '' },
  ]);
});

test('enforces internal workspace boundaries across every dependency section', () => {
  const violations = getManifestBoundaryViolations('packages/finance-core/package.json', {
    dependencies: {},
    devDependencies: { '@personal-budget/api': '0.1.0' },
    peerDependencies: { '@personal-budget/actual-adapter': '0.1.0' },
    optionalDependencies: {},
  });
  assert.equal(violations.length, 2);
  assert.match(violations[0] ?? '', /devDependencies/u);
  assert.match(violations[1] ?? '', /peerDependencies/u);
  assert.equal(getManifestBoundaryViolations('services/api/package.json', {
    devDependencies: { '@personal-budget/finance-core': '0.1.0' },
  }).length, 0);
  assert.equal(getManifestBoundaryViolations('package.json', {
    devDependencies: { '@personal-budget/api': '0.1.0' },
  }).length, 1);
  assert.match(
    getImportBoundaryViolation('packages/finance-core/src/domain.ts', '@personal-budget/api') ?? '',
    /forbidden workspace boundary/u,
  );
});

test('uses native ESLint complexity rules for changed source files', () => {
  assert.deepEqual(buildComplexityLintArgs(['apps/web/src/new-view.tsx'], 'node_modules/eslint/bin/eslint.js'), [
    'node_modules/eslint/bin/eslint.js',
    '--rule', 'complexity:["error",20]',
    '--rule', 'max-depth:["error",4]',
    'apps/web/src/new-view.tsx',
  ]);
});
