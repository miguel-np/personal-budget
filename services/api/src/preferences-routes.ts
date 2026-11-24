import { normalizeCurrencyCode } from '@personal-budget/finance-core';
import type { BudgetRepository } from '@personal-budget/finance-core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import {
  AccountScopeError, AccountScopePreferenceSchema, defaultAccountScope, readAccountScope,
  resolveAccountScope, writeAccountScope,
} from './account-scope.js';
import type { AccountScopePreference } from './account-scope.js';
import {
  AppPreferencesSchema, defaultAppPreferences, readAppPreferences, writeAppPreferences,
} from './app-preferences.js';
import {
  CurrencyPreferencesSchema, defaultCurrencyPreferences, readCurrencyPreferences, writeCurrencyPreferences,
} from './currency-preferences.js';
import type { CurrencyPreferences } from './currency-preferences.js';

const ResetPreferencesRequestSchema = z.object({ confirmation: z.literal('RESET_APP_PREFERENCES') }).strict();

interface SanitizedErrorResponse {
  readonly statusCode: number;
  readonly body: { readonly error: { readonly code: string; readonly message: string } };
}

export interface PreferencesRouteDependencies {
  readonly repository: BudgetRepository;
  readonly config: AppConfig;
  readonly currencyPreferences: () => Promise<CurrencyPreferences>;
  readonly accountScopePreference: () => Promise<AccountScopePreference>;
  readonly sanitizedErrorResponse: (error: unknown) => SanitizedErrorResponse;
}

export async function registerPreferencesRoutes(
  app: FastifyInstance,
  dependencies: PreferencesRouteDependencies,
): Promise<void> {
  const {
    repository, config, currencyPreferences, accountScopePreference, sanitizedErrorResponse,
  } = dependencies;

  app.get('/api/v1/preferences/accounts', async (_request, reply) => {
    try {
      const [accounts, preference] = await Promise.all([repository.listAccounts(), accountScopePreference()]);
      try {
        const resolved = resolveAccountScope(accounts, preference);
        return { data: { ...preference, label: resolved.metadata.label, activeAccountIds: resolved.metadata.accountIds, accountNames: resolved.metadata.accountNames } };
      } catch (error) {
        if (!(error instanceof AccountScopeError) || error.code !== 'INVALID_ACCOUNT_SCOPE') throw error;
        // Preserve access to settings so a user can repair a persisted scope after an account was closed or removed.
        return { data: {
          ...preference,
          label: 'Configuración pendiente: revisa las cuentas seleccionadas',
          activeAccountIds: [],
          accountNames: [],
          warning: error.message,
        } };
      }
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });
  app.put('/api/v1/preferences/accounts', async (request, reply) => {
    try {
      const preference = AccountScopePreferenceSchema.parse(request.body);
      const accounts = await repository.listAccounts();
      const resolved = resolveAccountScope(accounts, preference);
      await writeAccountScope(config.actualDataDir, preference);
      return { data: { ...preference, label: resolved.metadata.label, activeAccountIds: resolved.metadata.accountIds, accountNames: resolved.metadata.accountNames } };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });
  app.get('/api/v1/preferences/currency', async (_request, reply) => {
    try { return { data: { ...(await currencyPreferences()), budgetCurrency: config.budgetCurrency } }; }
    catch (error) { const normalized = sanitizedErrorResponse(error); return reply.code(normalized.statusCode).send(normalized.body); }
  });
  app.put('/api/v1/preferences/currency', async (request, reply) => {
    try {
      const preferences = CurrencyPreferencesSchema.parse(request.body);
      const accounts = await repository.listAccounts();
      const accountById = new Map(accounts.filter((account) => !account.closed).map((account) => [account.id, account]));
      for (const [accountId, currencyCode] of Object.entries(preferences.accountCurrencyOverrides)) {
        const account = accountById.get(accountId);
        if (!account) return reply.code(400).send({ error: { code: 'INVALID_ACCOUNT_CURRENCY', message: 'La divisa solo se puede asignar a una cuenta abierta del presupuesto configurado.' } });
        const sourceCurrency = normalizeCurrencyCode(account.currencyCode);
        if (sourceCurrency && sourceCurrency !== currencyCode) {
          return reply.code(400).send({ error: { code: 'NATIVE_CURRENCY_IS_AUTHORITATIVE', message: 'Actual Budget proporciona la divisa nativa de esta cuenta y tiene prioridad sobre la preferencia local.' } });
        }
      }
      await writeCurrencyPreferences(config.actualDataDir, preferences);
      return { data: { ...(await currencyPreferences()), budgetCurrency: config.budgetCurrency } };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });
  app.get('/api/v1/preferences/app', async (_request, reply) => {
    try { return { data: await readAppPreferences(config.actualDataDir) }; }
    catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });
  app.put('/api/v1/preferences/app', async (request, reply) => {
    try {
      const preferences = AppPreferencesSchema.parse(request.body);
      await writeAppPreferences(config.actualDataDir, preferences);
      return { data: await readAppPreferences(config.actualDataDir) };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });
  app.post('/api/v1/preferences/reset', async (request, reply) => {
    try {
      ResetPreferencesRequestSchema.parse(request.body);
      // Reset only app-owned JSON preferences. Never remove Actual's data directory, backups or browser downloads.
      await Promise.all([
        writeAppPreferences(config.actualDataDir, defaultAppPreferences()),
        writeCurrencyPreferences(config.actualDataDir, defaultCurrencyPreferences(config.budgetCurrency)),
        writeAccountScope(config.actualDataDir, defaultAccountScope()),
      ]);
      return {
        data: {
          reset: true,
          app: await readAppPreferences(config.actualDataDir),
          currency: { ...(await readCurrencyPreferences(config.actualDataDir, config.budgetCurrency)), budgetCurrency: config.budgetCurrency },
          accountScope: await readAccountScope(config.actualDataDir),
        },
      };
    } catch (error) {
      const normalized = sanitizedErrorResponse(error);
      return reply.code(normalized.statusCode).send(normalized.body);
    }
  });
}
