import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { convertAmountMinor } from '@personal-budget/finance-core';
import type { BudgetAccount, BudgetRepository } from '@personal-budget/finance-core';
import { z, ZodError } from 'zod';
import type { AppConfig } from './config.js';
import { readAccountScope, resolveAccountScope } from './account-scope.js';
import { readAppPreferences } from './app-preferences.js';
import { readCurrencyPreferences } from './currency-preferences.js';
import { readFinancialActionState } from './financial-actions-store.js';
import { readPeriodicReviewState } from './periodic-review-store.js';
import { readPlanningData } from './planning-store.js';
import {
  ExternalAssetSchema, WealthKindSchema, WealthClassificationSchema,
  calculateQuantityAmountMinor, readWealthData, updateWealthData,
} from './wealth-store.js';
import type { ExternalAsset, WealthKind } from './wealth-store.js';
import {
  DocumentInputSchema, addDocument, archiveDocument, deleteDocument, readDocumentFile,
  readDocumentIndex, setDocumentLinks, updateDocumentMetadata,
} from './documents-store.js';

const UUID = z.string().uuid();
const today = () => new Date().toISOString().slice(0, 10);
const AssetInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: WealthKindSchema,
  description: z.string().trim().max(2_000).optional(),
  owner: z.string().trim().max(120).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  acquiredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  includeInNetWorth: z.boolean().default(true),
  actualAccountId: z.string().trim().min(1).max(128).optional(),
}).strict();
const AssetPatchSchema = AssetInputSchema.partial().extend({ actualAccountId: z.string().trim().min(1).max(128).nullable().optional() }).strict();
const ValuationInputSchema = z.object({
  valuedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountMinor: z.number().int().refine(Number.isSafeInteger).nonnegative().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  source: z.enum(['manual', 'statement', 'document']).default('manual'),
  notes: z.string().trim().max(1_000).optional(),
  quantity: z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/).optional(),
  unitPriceMinor: z.number().int().refine(Number.isSafeInteger).nonnegative().optional(),
}).strict().superRefine((value, context) => {
  if ((value.quantity === undefined) !== (value.unitPriceMinor === undefined)) context.addIssue({ code: 'custom', path: ['quantity'], message: 'Quantity and unit price must be supplied together.' });
  if (value.quantity !== undefined) {
    const calculated = calculateQuantityAmountMinor(value.quantity, value.unitPriceMinor!);
    if (value.amountMinor !== undefined && value.amountMinor !== calculated) context.addIssue({ code: 'custom', path: ['amountMinor'], message: 'Amount must match quantity × unit price.' });
  } else if (value.amountMinor === undefined) {
    context.addIssue({ code: 'custom', path: ['amountMinor'], message: 'A total amount or quantity and unit price are required.' });
  }
});
const IdParams = z.object({ id: UUID }).strict();
const DeleteConfirmation = z.object({ confirm: z.literal(true) }).strict();
const DocumentMetadataHeader = z.string().max(8_000);
const LinkListSchema = z.array(z.object({
  transactionId: z.string().trim().min(1).max(128),
  accountId: z.string().trim().min(1).max(128),
  transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict()).max(100);
const ExportDatasetSchema = z.enum(['planning', 'preferences', 'financial-actions', 'periodic-reviews', 'wealth', 'documents', 'budgets']);

type Classification = 'asset' | 'liability';
interface Dependencies { readonly config: AppConfig; readonly repository: BudgetRepository; }
function error(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}
function isLiability(kind: WealthKind): boolean {
  return kind === 'loan' || kind === 'mortgage' || kind === 'other_liability';
}
function latestValuation(asset: ExternalAsset) {
  return [...asset.valuations].sort((a, b) => b.valuedAt.localeCompare(a.valuedAt) || b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}
function dayAge(from: string, to: string): number {
  return Math.floor((Date.parse(to + 'T00:00:00.000Z') - Date.parse(from + 'T00:00:00.000Z')) / 86_400_000);
}
function accountCurrency(account: BudgetAccount): string | null {
  const value = account.currencyCode;
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;
}
function safeDisplayName(value: string): string { return value.replace(/[\r\n"\\]/g, '_').slice(0, 160); }

export async function registerPortfolioRoutes(app: FastifyInstance, dependencies: Dependencies): Promise<void> {
  const { config, repository } = dependencies;
  const directory = config.actualDataDir;
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 }, (_request, body, done) => done(null, body));

  app.get('/api/v1/wealth', async (_request, reply) => {
    try { return { data: await readWealthData(directory) }; }
    catch { return error(reply, 500, 'WEALTH_STORAGE_UNAVAILABLE', 'No se pudo leer el registro patrimonial local.'); }
  });

  app.post('/api/v1/wealth/assets', async (request, reply) => {
    try {
      const input = AssetInputSchema.parse(request.body);
      if (input.actualAccountId) {
        const accounts = await repository.listAccounts();
        if (!accounts.some((account) => account.id === input.actualAccountId)) return error(reply, 400, 'UNKNOWN_ACTUAL_ACCOUNT', 'La cuenta de Actual indicada no existe.');
        if (input.includeInNetWorth) return error(reply, 400, 'DUPLICATE_ASSET', 'Un elemento ya representado por una cuenta de Actual no puede sumarse otra vez.');
      }
      const now = new Date().toISOString();
      const created = ExternalAssetSchema.parse({
        ...input, id: randomUUID(), status: 'active', includeInNetWorth: input.actualAccountId ? false : input.includeInNetWorth,
        valuations: [], createdAt: now, updatedAt: now,
      });
      const result = await updateWealthData(directory, (current) => {
        if (created.actualAccountId && current.assets.some((item) => item.actualAccountId === created.actualAccountId)) {
          throw new RangeError('La cuenta de Actual ya está vinculada a otro elemento patrimonial.');
        }
        return { data: { ...current, assets: [...current.assets, created] }, result: created };
      });
      return reply.code(201).send({ data: result });
    } catch (caught) {
      if (caught instanceof ZodError) return error(reply, 400, 'INVALID_WEALTH_INPUT', 'Los datos del elemento patrimonial no son válidos.');
      if (caught instanceof RangeError) return error(reply, 409, 'WEALTH_CONFLICT', caught.message);
      return error(reply, 500, 'WEALTH_STORAGE_UNAVAILABLE', 'No se pudo guardar el elemento patrimonial.');
    }
  });

  app.patch('/api/v1/wealth/assets/:id', async (request, reply) => {
    try {
      const { id } = IdParams.parse(request.params);
      const patch = AssetPatchSchema.parse(request.body);
      if (patch.actualAccountId) {
        const accounts = await repository.listAccounts();
        if (!accounts.some((account) => account.id === patch.actualAccountId)) return error(reply, 400, 'UNKNOWN_ACTUAL_ACCOUNT', 'La cuenta de Actual indicada no existe.');
        if (patch.includeInNetWorth === true) return error(reply, 400, 'DUPLICATE_ASSET', 'No se puede incluir un elemento ya representado por Actual.');
      }
      const result = await updateWealthData(directory, (current) => {
        const existing = current.assets.find((item) => item.id === id);
        if (!existing) return { data: current, result: null };
        const actualAccountId = patch.actualAccountId === undefined ? existing.actualAccountId : (patch.actualAccountId ?? undefined);
        const includeInNetWorth = actualAccountId ? false : (patch.actualAccountId === null ? (patch.includeInNetWorth ?? true) : (patch.includeInNetWorth ?? existing.includeInNetWorth));
        if (actualAccountId && current.assets.some((item) => item.id !== id && item.actualAccountId === actualAccountId)) {
          throw new RangeError('La cuenta de Actual ya está vinculada a otro elemento patrimonial.');
        }
        const updated = ExternalAssetSchema.parse({ ...existing, ...patch, actualAccountId, includeInNetWorth, id, status: existing.status, valuations: existing.valuations, createdAt: existing.createdAt, updatedAt: new Date().toISOString() });
        return { data: { ...current, assets: current.assets.map((item) => item.id === id ? updated : item) }, result: updated };
      });
      if (!result) return error(reply, 404, 'WEALTH_ASSET_NOT_FOUND', 'No existe ese elemento patrimonial.');
      return { data: result };
    } catch (caught) {
      if (caught instanceof ZodError) return error(reply, 400, 'INVALID_WEALTH_INPUT', 'Los datos del elemento patrimonial no son válidos.');
      if (caught instanceof RangeError) return error(reply, 409, 'WEALTH_CONFLICT', caught.message);
      return error(reply, 500, 'WEALTH_STORAGE_UNAVAILABLE', 'No se pudo actualizar el elemento patrimonial.');
    }
  });

  app.post('/api/v1/wealth/assets/:id/valuations', async (request, reply) => {
    try {
      const { id } = IdParams.parse(request.params);
      const input = ValuationInputSchema.parse(request.body);
      if (input.valuedAt > today()) return error(reply, 400, 'FUTURE_VALUATION', 'La fecha de valoración no puede ser futura.');
      const amountMinor = input.quantity !== undefined ? calculateQuantityAmountMinor(input.quantity, input.unitPriceMinor!) : input.amountMinor!;
      const result = await updateWealthData(directory, (current) => {
        const existing = current.assets.find((item) => item.id === id);
        if (!existing) return { data: current, result: null };
        if (input.currency !== existing.currency) throw new RangeError('La valoración debe usar la divisa del elemento; cambia la divisa al editar el elemento, no al sobrescribir su historial.');
        if (existing.valuations.length >= 500) throw new RangeError('El elemento ha alcanzado el límite de snapshots de valoración.');
        const valuation = {
          id: randomUUID(), valuedAt: input.valuedAt, amountMinor, currency: input.currency,
          source: input.source, ...(input.notes ? { notes: input.notes } : {}),
          ...(input.quantity !== undefined ? { quantity: input.quantity, unitPriceMinor: input.unitPriceMinor! } : {}),
          createdAt: new Date().toISOString(),
        };
        const updated = ExternalAssetSchema.parse({ ...existing, valuations: [...existing.valuations, valuation], updatedAt: new Date().toISOString() });
        return { data: { ...current, assets: current.assets.map((item) => item.id === id ? updated : item) }, result: valuation };
      });
      if (!result) return error(reply, 404, 'WEALTH_ASSET_NOT_FOUND', 'No existe ese elemento patrimonial.');
      return reply.code(201).send({ data: result });
    } catch (caught) {
      if (caught instanceof ZodError) return error(reply, 400, 'INVALID_VALUATION', 'Los datos de la valoración no son válidos.');
      if (caught instanceof RangeError) return error(reply, 409, 'WEALTH_CONFLICT', caught.message);
      return error(reply, 500, 'WEALTH_STORAGE_UNAVAILABLE', 'No se pudo guardar la valoración.');
    }
  });

  app.patch('/api/v1/wealth/assets/:id/status', async (request, reply) => {
    try {
      const { id } = IdParams.parse(request.params);
      const body = z.object({ status: z.enum(['active', 'archived']) }).strict().parse(request.body);
      const result = await updateWealthData(directory, (current) => {
        const existing = current.assets.find((item) => item.id === id);
        if (!existing) return { data: current, result: null };
        const updated = ExternalAssetSchema.parse({ ...existing, status: body.status, updatedAt: new Date().toISOString() });
        return { data: { ...current, assets: current.assets.map((item) => item.id === id ? updated : item) }, result: updated };
      });
      if (!result) return error(reply, 404, 'WEALTH_ASSET_NOT_FOUND', 'No existe ese elemento patrimonial.');
      return { data: result };
    } catch (caught) {
      if (caught instanceof ZodError) return error(reply, 400, 'INVALID_REQUEST', 'El estado solicitado no es válido.');
      return error(reply, 500, 'WEALTH_STORAGE_UNAVAILABLE', 'No se pudo cambiar el estado patrimonial.');
    }
  });

  app.delete('/api/v1/wealth/assets/:id', async (request, reply) => {
    try {
      const { id } = IdParams.parse(request.params);
      DeleteConfirmation.parse(request.body);
      const removed = await updateWealthData(directory, (current) => {
        const exists = current.assets.some((item) => item.id === id);
        return { data: { ...current, assets: current.assets.filter((item) => item.id !== id) }, result: exists };
      });
      if (!removed) return error(reply, 404, 'WEALTH_ASSET_NOT_FOUND', 'No existe ese elemento patrimonial.');
      return { data: { id, deleted: true } };
    } catch (caught) {
      if (caught instanceof ZodError) return error(reply, 400, 'CONFIRMATION_REQUIRED', 'Confirma expresamente la eliminación del elemento y de su historial.');
      return error(reply, 500, 'WEALTH_STORAGE_UNAVAILABLE', 'No se pudo eliminar el elemento patrimonial.');
    }
  });

  app.put('/api/v1/wealth/settings', async (request, reply) => {
    try {
      const settings = z.object({ staleAfterDays: z.number().int().min(30).max(365), includeOffBudgetAccounts: z.boolean() }).strict().parse(request.body);
      const updated = await updateWealthData(directory, (current) => ({ data: { ...current, settings }, result: settings }));
      return { data: updated };
    } catch (caught) {
      if (caught instanceof ZodError) return error(reply, 400, 'INVALID_WEALTH_SETTINGS', 'La configuración patrimonial no es válida.');
      return error(reply, 500, 'WEALTH_STORAGE_UNAVAILABLE', 'No se pudo guardar la configuración patrimonial.');
    }
  });

  app.put('/api/v1/wealth/accounts/:accountId/classification', async (request, reply) => {
    try {
      const params = z.object({ accountId: z.string().trim().min(1).max(128) }).strict().parse(request.params);
      const body = z.object({ classification: WealthClassificationSchema.nullable() }).strict().parse(request.body);
      const accounts = await repository.listAccounts();
      if (!accounts.some((item) => item.id === params.accountId)) return error(reply, 404, 'ACTUAL_ACCOUNT_NOT_FOUND', 'No existe esa cuenta de Actual.');
      const result = await updateWealthData(directory, (current) => {
        const other = current.accountClassifications.filter((item) => item.accountId !== params.accountId);
        const accountClassifications = body.classification === null ? other : [...other, { accountId: params.accountId, classification: body.classification, updatedAt: new Date().toISOString() }];
        return { data: { ...current, accountClassifications }, result: accountClassifications.find((item) => item.accountId === params.accountId) ?? null };
      });
      return { data: result };
    } catch (caught) {
      if (caught instanceof ZodError) return error(reply, 400, 'INVALID_ACCOUNT_CLASSIFICATION', 'La clasificación debe ser activo, pasivo o null.');
      return error(reply, 500, 'WEALTH_STORAGE_UNAVAILABLE', 'No se pudo guardar la clasificación.');
    }
  });

  app.get('/api/v1/wealth/summary', async (_request, reply) => {
    try {
      const [wealth, accounts, preferences, scopePreference] = await Promise.all([
        readWealthData(directory), repository.listAccounts(), readCurrencyPreferences(directory, config.budgetCurrency), readAccountScope(directory),
      ]);
      const displayCurrency = preferences.displayCurrency;
      const resolvedScope = resolveAccountScope(accounts, scopePreference);
      const todayDate = today();
      const accountClassifications = new Map(wealth.accountClassifications.map((item) => [item.accountId, item.classification]));
      const includedAccounts = resolvedScope.accounts.filter((account) => wealth.settings.includeOffBudgetAccounts || !account.offBudget);
      const warnings: string[] = [];
      const externalItems = wealth.assets.filter((item) => item.status === 'active');
      let complete = includedAccounts.length > 0 || externalItems.some((item) => item.includeInNetWorth && !item.actualAccountId);
      let totalMinor = 0;
      let actualMinor = 0;
      let externalMinor = 0;
      let actualAssetsMinor = 0;
      let actualLiabilitiesMinor = 0;
      let externalAssetsMinor = 0;
      let externalLiabilitiesMinor = 0;
      const unclassifiedAccountIds: string[] = [];
      const unconvertibleAccountIds: string[] = [];
      for (const account of includedAccounts) {
        const classification = accountClassifications.get(account.id);
        if (!classification) { complete = false; unclassifiedAccountIds.push(account.id); continue; }
        if (account.currentBalanceMinor === null) { complete = false; unconvertibleAccountIds.push(account.id); continue; }
        const conversion = convertAmountMinor(account.currentBalanceMinor, accountCurrency(account), displayCurrency, todayDate, preferences.exchangeRates);
        if (conversion.amountMinor === null) { complete = false; unconvertibleAccountIds.push(account.id); continue; }
        const amount = classification === 'liability' ? -Math.abs(conversion.amountMinor) : conversion.amountMinor;
        actualMinor += amount;
        if (classification === 'liability') actualLiabilitiesMinor += Math.abs(conversion.amountMinor);
        else actualAssetsMinor += conversion.amountMinor;
      }
      const staleAssets: string[] = [];
      const missingValuations: string[] = [];
      const excludedAsDuplicates: string[] = [];
      for (const item of externalItems) {
        if (!item.includeInNetWorth || item.actualAccountId) { excludedAsDuplicates.push(item.id); continue; }
        const valuation = latestValuation(item);
        if (!valuation) { complete = false; missingValuations.push(item.id); continue; }
        const age = dayAge(valuation.valuedAt, todayDate);
        if (age < 0 || age > wealth.settings.staleAfterDays) { complete = false; staleAssets.push(item.id); continue; }
        const conversion = convertAmountMinor(valuation.amountMinor, valuation.currency, displayCurrency, valuation.valuedAt, preferences.exchangeRates);
        if (conversion.amountMinor === null) { complete = false; staleAssets.push(item.id); continue; }
        const amount = isLiability(item.kind) ? -Math.abs(conversion.amountMinor) : conversion.amountMinor;
        externalMinor += amount;
        if (isLiability(item.kind)) externalLiabilitiesMinor += conversion.amountMinor;
        else externalAssetsMinor += conversion.amountMinor;
      }
      totalMinor = actualMinor + externalMinor;
      if (![actualMinor, externalMinor, totalMinor, actualAssetsMinor, actualLiabilitiesMinor, externalAssetsMinor, externalLiabilitiesMinor].every(Number.isSafeInteger)) {
        complete = false; warnings.push('El total excede el rango entero seguro; no se publica una cifra consolidada.');
      }
      if (unclassifiedAccountIds.length) warnings.push('Hay ' + unclassifiedAccountIds.length + ' cuenta(s) de Actual sin clasificación explícita de activo/pasivo.');
      if (unconvertibleAccountIds.length) warnings.push('Hay ' + unconvertibleAccountIds.length + ' cuenta(s) con saldo o conversión no disponible.');
      if (staleAssets.length) warnings.push('Hay ' + staleAssets.length + ' elemento(s) externo(s) sin valoración reciente o conversión fechada válida.');
      if (missingValuations.length) warnings.push('Hay ' + missingValuations.length + ' elemento(s) externo(s) sin valoración.');
      if (excludedAsDuplicates.length) warnings.push('Se excluyen ' + excludedAsDuplicates.length + ' elemento(s) ya representado(s) por cuentas de Actual o excluidos expresamente.');
      if (includedAccounts.length === 0) warnings.push('No hay cuentas dentro del ámbito patrimonial seleccionado.');
      return { data: {
        asOfDate: todayDate, currency: displayCurrency, status: complete ? 'available' : 'incomplete',
        netWorthMinor: complete && Number.isSafeInteger(totalMinor) ? totalMinor : null,
        actual: { netWorthMinor: Number.isSafeInteger(actualMinor) ? actualMinor : null, assetsMinor: actualAssetsMinor, liabilitiesMinor: actualLiabilitiesMinor, accountCount: includedAccounts.length },
        external: { netWorthMinor: Number.isSafeInteger(externalMinor) ? externalMinor : null, assetsMinor: externalAssetsMinor, liabilitiesMinor: externalLiabilitiesMinor, itemCount: externalItems.length },
        liquidity: { cashLikeExternalMinor: externalItems.filter((item) => item.kind === 'cash_external' && item.includeInNetWorth && !item.actualAccountId).reduce((sum, item) => {
          const value = latestValuation(item);
          if (!value) return sum;
          const age = dayAge(value.valuedAt, todayDate);
          if (age < 0 || age > wealth.settings.staleAfterDays) return sum;
          const conversion = convertAmountMinor(value.amountMinor, value.currency, displayCurrency, value.valuedAt, preferences.exchangeRates);
          return conversion.amountMinor === null ? sum : sum + conversion.amountMinor;
        }, 0) },
        coverage: { includedActualAccounts: includedAccounts.length, unclassifiedAccountIds, unconvertibleAccountIds, staleAssetIds: staleAssets, missingValuationIds: missingValuations, excludedDuplicateOrOptOutIds: excludedAsDuplicates },
        settings: wealth.settings, warnings,
      } };
    } catch (caught) {
      if (caught instanceof ZodError) return error(reply, 400, 'INVALID_WEALTH_STATE', 'La configuración o el ámbito patrimonial local no son válidos.');
      return error(reply, 500, 'WEALTH_SUMMARY_UNAVAILABLE', 'No se pudo calcular el patrimonio consolidado con datos verificables.');
    }
  });

  app.get('/api/v1/documents', async (request, reply) => {
    try {
      const query = z.object({
        transactionId: z.string().trim().min(1).max(128).optional(),
        includeArchived: z.enum(['true', 'false']).default('false'),
      }).strict().parse(request.query);
      const index = await readDocumentIndex(directory);
      const documents = index.documents.filter((item) =>
        (query.includeArchived === 'true' || !item.archivedAt) &&
        (!query.transactionId || item.links.some((link) => link.transactionId === query.transactionId)));
      return { data: documents };
    } catch { return error(reply, 500, 'DOCUMENT_INDEX_UNAVAILABLE', 'No se pudo leer el archivo documental local.'); }
  });

  app.post('/api/v1/documents', { bodyLimit: 10 * 1024 * 1024 }, async (request, reply) => {
    try {
      if (!Buffer.isBuffer(request.body)) return error(reply, 415, 'DOCUMENT_CONTENT_TYPE_REQUIRED', 'Envía el archivo como application/octet-stream.');
      const rawHeader = request.headers['x-document-metadata'];
      const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
      if (!header) return error(reply, 400, 'DOCUMENT_METADATA_REQUIRED', 'Faltan los metadatos del documento.');
      const metadata = DocumentInputSchema.parse(JSON.parse(DocumentMetadataHeader.parse(header)));
      const record = await addDocument(directory, request.body, metadata);
      return reply.code(201).send({ data: record });
    } catch (caught) {
      if (caught instanceof ZodError || caught instanceof SyntaxError) return error(reply, 400, 'INVALID_DOCUMENT_METADATA', 'Los metadatos del documento no son válidos.');
      if (caught instanceof RangeError) return error(reply, 413, 'DOCUMENT_SIZE_LIMIT', 'El documento supera los límites admitidos.');
      if (caught instanceof TypeError) return error(reply, 415, 'UNSUPPORTED_DOCUMENT_TYPE', 'Solo se admiten documentos PDF, JPEG o PNG válidos.');
      return error(reply, 500, 'DOCUMENT_STORAGE_UNAVAILABLE', 'No se pudo guardar el documento local.');
    }
  });

  app.patch('/api/v1/documents/:id', async (request, reply) => {
    try {
      const { id } = IdParams.parse(request.params);
      const result = await updateDocumentMetadata(directory, id, request.body);
      if (!result) return error(reply, 404, 'DOCUMENT_NOT_FOUND', 'No existe ese documento.');
      return { data: result };
    } catch (caught) {
      if (caught instanceof ZodError) return error(reply, 400, 'INVALID_DOCUMENT_METADATA', 'Los metadatos del documento no son válidos.');
      return error(reply, 500, 'DOCUMENT_STORAGE_UNAVAILABLE', 'No se pudo actualizar el documento.');
    }
  });

  app.put('/api/v1/documents/:id/links', async (request, reply) => {
    try {
      const { id } = IdParams.parse(request.params);
      const links = LinkListSchema.parse(request.body);
      for (const link of links) {
        const rows = await repository.listTransactions(link.accountId, link.transactionDate, link.transactionDate);
        if (!rows.some((row) => row.id === link.transactionId && row.account === link.accountId && row.date === link.transactionDate)) {
          return error(reply, 409, 'TRANSACTION_LINK_NOT_VERIFIED', 'Uno de los movimientos ya no existe o no coincide con su cuenta/fecha; no se guardó ningún vínculo.');
        }
      }
      const result = await setDocumentLinks(directory, id, links);
      if (!result) return error(reply, 404, 'DOCUMENT_NOT_FOUND', 'No existe ese documento.');
      return { data: result };
    } catch (caught) {
      if (caught instanceof ZodError) return error(reply, 400, 'INVALID_DOCUMENT_LINKS', 'La lista de movimientos vinculados no es válida.');
      return error(reply, 502, 'TRANSACTION_LOOKUP_FAILED', 'No se pudieron verificar los movimientos seleccionados.');
    }
  });

  app.patch('/api/v1/documents/:id/archive', async (request, reply) => {
    try {
      const { id } = IdParams.parse(request.params);
      const body = z.object({ archived: z.boolean() }).strict().parse(request.body);
      const result = await archiveDocument(directory, id, body.archived);
      if (!result) return error(reply, 404, 'DOCUMENT_NOT_FOUND', 'No existe ese documento.');
      return { data: result };
    } catch (caught) {
      if (caught instanceof ZodError) return error(reply, 400, 'INVALID_REQUEST', 'La solicitud de archivo no es válida.');
      return error(reply, 500, 'DOCUMENT_STORAGE_UNAVAILABLE', 'No se pudo cambiar el estado del documento.');
    }
  });

  app.delete('/api/v1/documents/:id', async (request, reply) => {
    try {
      const { id } = IdParams.parse(request.params);
      DeleteConfirmation.parse(request.body);
      const removed = await deleteDocument(directory, id);
      if (!removed) return error(reply, 404, 'DOCUMENT_NOT_FOUND', 'No existe ese documento.');
      return { data: { id, deleted: true } };
    } catch (caught) {
      if (caught instanceof ZodError) return error(reply, 400, 'CONFIRMATION_REQUIRED', 'Confirma expresamente la eliminación irreversible del archivo.');
      return error(reply, 500, 'DOCUMENT_STORAGE_UNAVAILABLE', 'No se pudo eliminar el documento local.');
    }
  });

  app.get('/api/v1/documents/:id/file', async (request, reply) => {
    try {
      const { id } = IdParams.parse(request.params);
      const index = await readDocumentIndex(directory);
      const record = index.documents.find((item) => item.id === id);
      if (!record) return error(reply, 404, 'DOCUMENT_NOT_FOUND', 'No existe ese documento.');
      const file = await readDocumentFile(directory, record);
      reply.header('content-type', record.mediaType);
      reply.header('content-disposition', 'attachment; filename="' + safeDisplayName(record.fileName) + '"');
      reply.header('content-length', String(file.length));
      reply.header('x-content-type-options', 'nosniff');
      return reply.send(file);
    } catch { return error(reply, 500, 'DOCUMENT_FILE_UNAVAILABLE', 'El archivo no está disponible o no supera su comprobación de integridad.'); }
  });

  app.get('/api/v1/portable-export', async (request, reply) => {
    try {
      const query = z.object({
        datasets: z.string().min(1).max(300),
        budgetMonths: z.string().max(100).optional(),
        includeDocumentFiles: z.enum(['true', 'false']).default('false'),
      }).strict().parse(request.query);
      const names = [...new Set(query.datasets.split(',').map((item) => item.trim()).filter(Boolean))];
      const datasets = z.array(ExportDatasetSchema).min(1).max(7).parse(names);
      const data: Record<string, unknown> = {};
      const manifest: Array<{ id: string; schemaVersion: number; source: string; recordCount: number; included: boolean; limitations: string[] }> = [];
      const add = (id: string, schemaVersion: number, source: string, value: unknown, recordCount: number, limitations: string[] = []) => {
        data[id] = value;
        manifest.push({ id, schemaVersion, source, recordCount, included: true, limitations });
      };
      for (const dataset of datasets) {
        if (dataset === 'planning') {
          const value = await readPlanningData(directory);
          add(dataset, 1, 'personal-budget', value, value.goals.length + value.commitments.length);
        } else if (dataset === 'preferences') {
          const [appPreferences, accountScope, currencyPreferences] = await Promise.all([
            readAppPreferences(directory), readAccountScope(directory), readCurrencyPreferences(directory, config.budgetCurrency),
          ]);
          const value = { app: appPreferences, accountScope, currency: currencyPreferences };
          add(dataset, 1, 'personal-budget', value, Object.keys(value).length, ['No incluye secretos ni credenciales.']);
        } else if (dataset === 'financial-actions') {
          const value = await readFinancialActionState(directory);
          add(dataset, 1, 'personal-budget', value, value.budgetAlerts.rules.length + value.budgetAlerts.events.length + value.budgetImprovements.categories.length + value.budgetImprovements.decisions.length + value.budgetImprovements.scenarios.length);
        } else if (dataset === 'periodic-reviews') {
          const value = await readPeriodicReviewState(directory);
          add(dataset, 1, 'personal-budget', value, value.reviews.length);
        } else if (dataset === 'wealth') {
          const value = await readWealthData(directory);
          add(dataset, 1, 'personal-budget-manual-valuations', value, value.assets.length + value.accountClassifications.length);
        } else if (dataset === 'budgets') {
          const months = query.budgetMonths?.split(',').map((item) => item.trim()).filter(Boolean) ?? [today().slice(0, 7)];
          const requestedMonths = [...new Set(z.array(z.string().regex(/^\\d{4}-(0[1-9]|1[0-2])$/)).min(1).max(12).parse(months))];
          const budgetRepository = repository as BudgetRepository & {
            getBudgetMonth?: (month: string) => Promise<{ readonly month: string; readonly totalBudgeted?: number | null; readonly totalSpent?: number | null; readonly totalBalance?: number | null; readonly totalIncome?: number | null; readonly incomeAvailable?: number | null; readonly toBudget?: number | null; readonly categoryGroups: readonly { readonly id: string; readonly name: string; readonly is_income?: boolean; readonly hidden?: boolean; readonly categories?: readonly { readonly id: string; readonly name: string; readonly budgeted?: number | null; readonly spent?: number | null; readonly balance?: number | null; readonly hidden?: boolean; readonly carryover?: boolean | null }[] }[] }>;
            getBudgetAllocations?: (month: string) => Promise<readonly { readonly categoryId: string; readonly amountMinor: number }[]>;
          };
          if (typeof budgetRepository.getBudgetMonth !== 'function') {
            manifest.push({ id: dataset, schemaVersion: 1, source: 'actual-budget-api', recordCount: 0, included: false, limitations: ['El adaptador conectado no expone la consulta mensual de presupuestos; no se ha generado un conjunto vacío engañoso.'] });
            continue;
          }
          const categories = await repository.listCategories();
          const categoriesById = new Map(categories.map((category) => [category.id, category]));
          const budgetSnapshots = [];
          let recordCount = 0;
          let explicitAllocationAvailable = true;
          for (const month of requestedMonths) {
            const [budget, allocations] = await Promise.all([
              budgetRepository.getBudgetMonth(month),
              typeof budgetRepository.getBudgetAllocations === 'function' ? budgetRepository.getBudgetAllocations(month) : Promise.resolve(null),
            ]);
            if (allocations === null) explicitAllocationAvailable = false;
            const allocationByCategory = new Map((allocations ?? []).map((item) => [item.categoryId, item.amountMinor]));
            const groups = budget.categoryGroups.map((group) => ({
              id: group.id, name: group.name, isIncome: group.is_income ?? false,
              categories: (group.categories ?? []).map((category) => {
                recordCount += 1;
                const explicit = allocationByCategory.get(category.id);
                const metadata = categoriesById.get(category.id);
                return {
                  id: category.id, name: metadata?.name ?? category.name,
                  budgetedMinor: allocations !== null ? (explicit ?? 0) : (category.budgeted ?? null),
                  spentMinor: category.spent === undefined || category.spent === null ? null : Math.abs(category.spent),
                  availableMinor: category.balance ?? null,
                  hidden: category.hidden ?? group.hidden ?? false,
                  categoryGroup: group.name, state: allocations !== null ? (explicit === undefined ? 'unbudgeted' : explicit === 0 ? 'zero' : 'budgeted') : 'allocation-detail-unavailable',
                };
              }),
            }));
            budgetSnapshots.push({
              month: budget.month,
              totals: { totalBudgetedMinor: budget.totalBudgeted ?? null, totalSpentMinor: budget.totalSpent === undefined || budget.totalSpent === null ? null : Math.abs(budget.totalSpent), totalBalanceMinor: budget.totalBalance ?? null, totalIncomeMinor: budget.totalIncome ?? null, incomeAvailableMinor: budget.incomeAvailable ?? null, toBudgetMinor: budget.toBudget ?? null },
              groups,
              source: 'actual-budget-api',
            });
          }
          add(dataset, 1, 'actual-budget-api', { months: budgetSnapshots }, recordCount, explicitAllocationAvailable ? [] : ['El adaptador no expone asignaciones de presupuesto explícitas; no se puede distinguir un cero guardado de una categoría sin asignación.']);
        } else if (dataset === 'documents') {
          const index = await readDocumentIndex(directory);
          const files: Array<{ documentId: string; fileName: string; mediaType: string; base64: string }> = [];
          if (query.includeDocumentFiles === 'true') {
            let total = 0;
            for (const record of index.documents) {
              const contents = await readDocumentFile(directory, record);
              total += contents.length;
              if (total > 20 * 1024 * 1024) return error(reply, 413, 'PORTABLE_EXPORT_TOO_LARGE', 'Selecciona menos documentos: la exportación portable admite hasta 20 MiB de contenido binario.');
              files.push({ documentId: record.id, fileName: record.fileName, mediaType: record.mediaType, base64: contents.toString('base64') });
            }
          }
          add(dataset, 1, 'personal-budget-local-files', {
            metadata: index,
            ...(query.includeDocumentFiles === 'true' ? { files } : {}),
          }, index.documents.length, query.includeDocumentFiles === 'true' ? [] : ['Se exportan los metadatos y vínculos; el contenido binario de los justificantes queda fuera.']);
        }
      }
      const [exportCurrency, exportScope] = await Promise.all([
        readCurrencyPreferences(directory, config.budgetCurrency), readAccountScope(directory),
      ]);
      let accountCount: number | null = null;
      let accountScopeWarning: string | null = null;
      try {
        const exportAccounts = await repository.listAccounts();
        accountCount = resolveAccountScope(exportAccounts, exportScope).accounts.length;
      } catch {
        accountScopeWarning = 'Actual no está disponible para verificar el recuento de cuentas del contexto; los conjuntos locales seleccionados sí se han exportado.';
      }
      const result = {
        format: 'personal-budget-portable-export',
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        context: {
          asOfDate: today(), currency: exportCurrency.displayCurrency,
          accountScope: { mode: exportScope.mode, accountCount },
          budgetMonths: datasets.includes('budgets') ? (query.budgetMonths?.split(',').map((item) => item.trim()).filter(Boolean) ?? [today().slice(0, 7)]) : [],
        },
        manifest,
        data,
        warnings: [...manifest.flatMap((entry) => entry.limitations), ...(accountScopeWarning ? [accountScopeWarning] : [])],
        exclusions: [
          'Actual transactions and financial reports: export them using the existing Movements and Reports export flows.',
          'Secrets, credentials, encryption keys, environment variables, logs and private filesystem paths are never included.',
          'This human-readable snapshot is not a restorable backup and does not replace the encrypted backup/restore workflow.',
          'Saved hypothetical scenarios retain their own planning provenance and are not Actual transactions.',
        ],
      };
      return reply.send(result);
    } catch (caught) {
      if (caught instanceof ZodError) return error(reply, 400, 'INVALID_PORTABLE_EXPORT_SELECTION', 'Selecciona únicamente conjuntos de datos disponibles.');
      return error(reply, 500, 'PORTABLE_EXPORT_FAILED', 'No se pudo generar la exportación local.');
    }
  });
}
