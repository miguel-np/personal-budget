import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccountScopePreferenceSchema, defaultAccountScope, readAccountScope, resolveAccountScope, writeAccountScope,
} from '../src/account-scope.js';

const directories: string[] = [];
async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'budget-account-scope-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const accounts = [
  { id: 'checking', name: 'Cuenta corriente', closed: false },
  { id: 'savings', name: 'Ahorro', closed: false },
  { id: 'closed', name: 'Cuenta antigua', closed: true },
] as const;

describe('persistent account scope', () => {
  it('defaults to all open accounts and labels the scope', () => {
    const scope = resolveAccountScope(accounts, defaultAccountScope());
    expect(scope.accounts.map((account) => account.id)).toEqual(['checking', 'savings']);
    expect(scope.metadata.label).toBe('Todas las cuentas abiertas (2)');
  });

  it('supports a selected list, a single local refinement, and a deliberately empty selection', () => {
    const selected = resolveAccountScope(accounts, { mode: 'selected', accountIds: ['savings', 'checking'] });
    expect(selected.accounts.map((account) => account.id)).toEqual(['savings', 'checking']);
    expect(resolveAccountScope(accounts, { mode: 'selected', accountIds: ['savings', 'checking'] }, 'checking').metadata.label)
      .toBe('Filtro local: Cuenta corriente');
    expect(resolveAccountScope(accounts, { mode: 'selected', accountIds: [] }).accounts).toEqual([]);
  });

  it('rejects invalid/closed saved accounts and prevents a local filter expanding the global scope', () => {
    expect(() => resolveAccountScope(accounts, { mode: 'selected', accountIds: ['closed'] })).toThrow(/cerradas o inexistentes/i);
    expect(() => resolveAccountScope(accounts, { mode: 'selected', accountIds: ['checking'] }, 'savings')).toThrow(/no puede ampliar/i);
    expect(() => resolveAccountScope(accounts, { mode: 'all', accountIds: [] }, 'missing')).toThrow(/no existe o está cerrada/i);
  });

  it('validates uniqueness and the all-mode contract', () => {
    expect(() => AccountScopePreferenceSchema.parse({ mode: 'selected', accountIds: ['checking', 'checking'] })).toThrow(/duplicate/i);
    expect(() => AccountScopePreferenceSchema.parse({ mode: 'all', accountIds: ['checking'] })).toThrow(/all-accounts/i);
  });

  it('persists locally and does not require remote services', async () => {
    const directory = await fixture();
    await expect(readAccountScope(directory)).resolves.toEqual({ mode: 'all', accountIds: [] });
    const preference = { mode: 'selected' as const, accountIds: ['checking', 'savings'] };
    await writeAccountScope(directory, preference);
    await expect(readAccountScope(directory)).resolves.toEqual(preference);
    expect(await readFile(join(directory, 'account-scope-preferences.json'), 'utf8')).toContain('"mode": "selected"');
  });
});
