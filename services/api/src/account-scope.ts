import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const AccountId = z.string().trim().min(1).max(128);
export const AccountScopePreferenceSchema = z.object({
  mode: z.enum(['all', 'selected']),
  accountIds: z.array(AccountId).max(500),
}).strict().superRefine((value, context) => {
  if (new Set(value.accountIds).size !== value.accountIds.length) {
    context.addIssue({ code: 'custom', message: 'Account scope cannot contain duplicate account IDs.' });
  }
  if (value.mode === 'all' && value.accountIds.length > 0) {
    context.addIssue({ code: 'custom', message: 'The all-accounts scope must not include explicit account IDs.' });
  }
});

export interface AccountScopePreference {
  readonly mode: 'all' | 'selected';
  readonly accountIds: readonly string[];
}

export interface AccountScopeAccount {
  readonly id: string;
  readonly name: string;
  readonly closed: boolean;
}

export interface AccountScopeMetadata {
  readonly mode: 'all' | 'selected';
  readonly accountIds: readonly string[];
  readonly accountNames: readonly string[];
  readonly label: string;
}

export interface ResolvedAccountScope {
  readonly accounts: readonly AccountScopeAccount[];
  readonly metadata: AccountScopeMetadata;
}

export class AccountScopeError extends Error {
  public readonly code: 'INVALID_ACCOUNT_SCOPE' | 'INVALID_ACCOUNT' | 'ACCOUNT_OUTSIDE_SCOPE';

  public constructor(code: AccountScopeError['code'], message: string) {
    super(message);
    this.name = 'AccountScopeError';
    this.code = code;
  }
}

export function defaultAccountScope(): AccountScopePreference {
  return { mode: 'all', accountIds: [] };
}

export async function readAccountScope(dataDirectory: string): Promise<AccountScopePreference> {
  const path = resolve(dataDirectory, 'account-scope-preferences.json');
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return defaultAccountScope();
    throw error;
  }
  return AccountScopePreferenceSchema.parse(JSON.parse(contents) as unknown);
}

export async function writeAccountScope(dataDirectory: string, scope: AccountScopePreference): Promise<void> {
  const parsed = AccountScopePreferenceSchema.parse(scope);
  const path = resolve(dataDirectory, 'account-scope-preferences.json');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporaryPath, JSON.stringify(parsed, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await chmod(temporaryPath, 0o600).catch(() => undefined);
    await rename(temporaryPath, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

/** Resolve the persisted global scope and an optional, narrower per-screen account filter. */
export function resolveAccountScope(
  allAccounts: readonly AccountScopeAccount[],
  preference: AccountScopePreference,
  requestedAccountId?: string,
): ResolvedAccountScope {
  const openAccounts = allAccounts.filter((account) => !account.closed);
  const openById = new Map(openAccounts.map((account) => [account.id, account]));
  let accounts: readonly AccountScopeAccount[];

  if (preference.mode === 'all') {
    accounts = openAccounts;
  } else {
    const invalid = preference.accountIds.filter((id) => !openById.has(id));
    if (invalid.length > 0) {
      throw new AccountScopeError(
        'INVALID_ACCOUNT_SCOPE',
        'La selección global guardada contiene cuentas cerradas o inexistentes. Revisa Configuración y guarda de nuevo el ámbito de cuentas.',
      );
    }
    accounts = preference.accountIds
      .map((id) => openById.get(id))
      .filter((account): account is AccountScopeAccount => account !== undefined);
  }

  if (requestedAccountId !== undefined) {
    const requested = openById.get(requestedAccountId);
    if (!requested) {
      throw new AccountScopeError('INVALID_ACCOUNT', 'La cuenta solicitada no existe o está cerrada en el presupuesto actual.');
    }
    if (!accounts.some((account) => account.id === requestedAccountId)) {
      throw new AccountScopeError(
        'ACCOUNT_OUTSIDE_SCOPE',
        'El filtro local no puede ampliar el ámbito global. Incluye esta cuenta en Configuración o restablece «Todas las cuentas abiertas».',
      );
    }
    accounts = [requested];
  }

  const accountIds = accounts.map((account) => account.id);
  const accountNames = accounts.map((account) => account.name);
  const label = preference.mode === 'all' && requestedAccountId === undefined
    ? 'Todas las cuentas abiertas (' + accounts.length + ')'
    : accounts.length === 0
      ? 'Ninguna cuenta seleccionada'
      : requestedAccountId !== undefined
        ? 'Filtro local: ' + (accountNames[0] ?? 'Cuenta')
        : 'Cuentas seleccionadas: ' + accountNames.join(', ');

  return {
    accounts,
    metadata: {
      mode: preference.mode,
      accountIds,
      accountNames,
      label,
    },
  };
}
