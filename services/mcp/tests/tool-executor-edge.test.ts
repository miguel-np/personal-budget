import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '../tool-executors.mjs';

function apiResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('MCP API response boundaries', () => {
  it('rejects summaries and transaction responses with invalid shapes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => apiResponse({})));
    await expect(invoke('get_monthly_summary', { month: '2026-01' })).rejects.toThrow('Invalid summary.');

    vi.stubGlobal('fetch', vi.fn(async () => apiResponse({ not: 'an array' })));
    await expect(invoke('get_uncategorized_transactions', {
      startDate: '2026-01-01',
      endDate: '2026-01-31'
    })).rejects.toThrow('Invalid transactions.');
  });

  it('handles a successful response with no body as invalid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null)));
    await expect(invoke('get_monthly_summary', { month: '2026-01' })).rejects.toThrow();
  });

  it('only returns recurring candidates backed by at least three stable monthly records', async () => {
    const records = [
      { payee_name: 12, imported_payee: null, date: '2026-01-01', amount: -100 },
      { imported_payee: 'Fallback merchant', date: '2026-01-01', amount: -1000 },
      { imported_payee: 'Fallback merchant', date: '2026-01-31', amount: -1020 },
      { imported_payee: 'Fallback merchant', date: '2026-03-02', amount: -980 },
      { payee_name: 'Only twice', date: '2026-01-01', amount: -500 },
      { payee_name: 'Only twice', date: '2026-01-31', amount: -500 },
      { payee_name: 'Too frequent', date: '2026-01-01', amount: -100 },
      { payee_name: 'Too frequent', date: '2026-01-11', amount: -100 },
      { payee_name: 'Too frequent', date: '2026-01-21', amount: -100 },
      { payee_name: 'Too sparse', date: '2026-01-01', amount: -100 },
      { payee_name: 'Too sparse', date: '2026-03-02', amount: -100 },
      { payee_name: 'Too sparse', date: '2026-05-01', amount: -100 },
      { payee_name: 'Unstable amounts', date: '2026-01-01', amount: -1000 },
      { payee_name: 'Unstable amounts', date: '2026-01-31', amount: -1000 },
      { payee_name: 'Unstable amounts', date: '2026-03-02', amount: -2000 },
      { payee_name: 'Invalid date', date: '2026-02-30', amount: -100 },
      { payee_name: 'Unsafe amount', date: '2026-02-01', amount: Number.MAX_SAFE_INTEGER + 1 }
    ];
    vi.stubGlobal('fetch', vi.fn(async () => apiResponse(records)));

    const result = await invoke('get_recurring_candidates', {
      startDate: '2026-01-01',
      endDate: '2026-05-31'
    });

    expect(result).toMatchObject({
      sourceRecords: records.length,
      truncated: false,
      candidates: [{
        payee: 'Fallback merchant',
        occurrenceCount: 3,
        estimatedIntervalDays: 30,
        confidence: 'candidate_only'
      }]
    });
  });

  it('preserves safe defaults when optional findings, improvement and wealth fields are absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      const url = new URL(String(request));
      if (url.pathname.endsWith('/intelligence/findings')) {
        return apiResponse({ period: {}, currency: 'EUR', findings: [] });
      }
      if (url.pathname.endsWith('/budget-improvements')) {
        return apiResponse({
          asOfDate: '2026-01-31',
          currency: 'EUR',
          goal: null,
          baseline: {
            startDate: '2025-11-01',
            endDate: '2026-01-31',
            periodMonths: 3,
            monthlyIncomeMinor: 100,
            monthlyExpenseMinor: 80,
            monthlySavingsMinor: 20,
            savingsRatePercent: 20,
            transactionCount: 1,
            unconvertedTransactionCount: 0
          },
          proposals: [{
            categoryName: 'Comida',
            kind: 'reduce',
            suggestedReductionPercent: 5,
            observedMonthlyExpenseMinor: 80,
            estimatedMonthlySavingsMinor: 4,
            estimatedAnnualSavingsMinor: 48,
            confidence: 0.8,
            explanation: 'Synthetic fixture',
            evidence: [],
            assumptions: [],
            priorityRank: 1,
            priorityReason: 'synthetic'
          }],
          savingsGoals: [{
            name: 'Reserva',
            targetDate: '2027-01-01',
            targetAmountMinor: 100,
            initialAmountMinor: 0,
            monthlyContributionMinor: 10,
            currency: 'EUR',
            status: 'active',
            projection: null
          }]
        });
      }
      if (url.pathname.endsWith('/wealth/summary')) {
        return apiResponse({
          asOfDate: '2026-01-31',
          currency: 'EUR',
          status: 'complete',
          netWorthMinor: 100,
          actual: { assetsMinor: 100, liabilitiesMinor: 0 },
          external: { assetsMinor: 0, liabilitiesMinor: 0 },
          coverage: { includedActualAccounts: 1 }
        });
      }
      return apiResponse({}, 404);
    }));

    const findings = await invoke('get_financial_findings', {
      startDate: '2026-01-01',
      endDate: '2026-01-31'
    });
    expect(findings).toMatchObject({ accountScopeLabel: null, findings: [], warnings: [] });

    const improvements = await invoke('get_budget_improvement_context', {});
    expect(improvements).toMatchObject({
      proposals: [{ goalImpact: null }],
      savingsGoals: [{ projection: null, warnings: [] }],
      warnings: []
    });

    const wealth = await invoke('get_net_worth_summary', {});
    expect(wealth).toMatchObject({
      coverage: {
        unclassifiedAccountCount: 0,
        unconvertibleAccountCount: 0,
        staleAssetCount: 0,
        missingValuationCount: 0,
        excludedDuplicateOrOptOutCount: 0
      },
      warnings: []
    });
  });

  it('rejects incomplete cash-flow projection responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => apiResponse({ projection: null })));
    await expect(invoke('project_cash_flow', {})).rejects.toThrow('Invalid cash-flow projection response.');
  });
});
