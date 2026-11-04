import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.local/**',
      // Vendored Impeccable tooling is maintained upstream, not part of app source linting.
      '**/.agents/skills/impeccable/scripts/live-browser.js',
      '**/.agents/skills/impeccable/scripts/modern-screenshot.umd.js',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
