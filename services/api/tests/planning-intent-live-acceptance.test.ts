import { describe, expect, it } from 'vitest';
import { LocalAiClient } from '../src/local-ai.js';
import type { PlanningExtractionContext, PlanningIntentDraft } from '../src/local-ai.js';

const enabled = process.env.PERSONAL_BUDGET_RUN_PLANNING_AI_ACCEPTANCE === '1' &&
  Boolean(process.env.OLLAMA_MODEL?.trim());
const baseURL = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
const model = process.env.OLLAMA_MODEL?.trim();

const syntheticGoalId = '4d7c23a8-bcc8-49df-94ba-d64851df8aa2';
const extractionContext: PlanningExtractionContext = {
  asOfDate: '2026-10-30',
  currency: 'EUR',
  goals: [{ id: syntheticGoalId, name: 'Fondo de emergencia sintético' }],
};

const evaluationCases: readonly {
  readonly question: string;
  readonly expected: Partial<PlanningIntentDraft>;
  readonly clarificationExpected?: boolean;
}[] = [
  {
    question: 'Quiero ahorrar 5.000 EUR para el 30/06/2027 y aportar 200 EUR al mes.',
    expected: {
      intent: 'goal_plan', targetAmountMajor: 5_000, targetDate: '2027-06-30',
      monthlyContributionMajor: 200, currency: 'EUR',
    },
  },
  {
    question: 'Compara aportaciones mensuales de 150 EUR y 250 EUR para un objetivo de 5.000 EUR con fecha 2027-06-30.',
    expected: {
      intent: 'compare_contributions', targetAmountMajor: 5_000, targetDate: '2027-06-30',
      contributionOptionsMajor: [150, 250], currency: 'EUR',
    },
  },
  {
    question: 'Comprueba el impacto en el objetivo Fondo de emergencia sintético si gasto 900 EUR el 2027-01-15.',
    expected: {
      intent: 'test_expense', goalId: syntheticGoalId, expenseAmountMajor: 900,
      expenseDate: '2027-01-15', currency: 'EUR',
    },
  },
  {
    question: 'Quiero ahorrar para un viaje.',
    expected: { intent: 'goal_plan', targetAmountMajor: null, targetDate: null },
    clarificationExpected: true,
  },
];

describe.skipIf(!enabled)('Ollama planning-intent live acceptance (synthetic prompts only)', () => {
  it('measures structured-field accuracy and clarification detection', async () => {
    if (!model) throw new Error('OLLAMA_MODEL must name an installed local model.');
    const client = new LocalAiClient({
      enabled: true, baseURL, model, timeoutMs: 120_000, maxContextChars: 4_000,
    });
    await expect(client.status()).resolves.toMatchObject({ status: 'available', model });

    let matchedFields = 0;
    let expectedFields = 0;
    let clarificationTruePositives = 0;
    let clarificationCases = 0;
    const observations: Array<Record<string, unknown>> = [];

    for (const testCase of evaluationCases) {
      const extracted = await client.extractPlanningIntent(testCase.question, extractionContext) as PlanningIntentDraft;
      for (const [field, expected] of Object.entries(testCase.expected)) {
        expectedFields += 1;
        const actual = extracted[field as keyof PlanningIntentDraft];
        const matches = field === 'contributionOptionsMajor' && Array.isArray(actual) && Array.isArray(expected)
          ? JSON.stringify([...actual].sort((a, b) => Number(a) - Number(b))) ===
            JSON.stringify([...expected].sort((a, b) => Number(a) - Number(b)))
          : Object.is(actual, expected);
        if (matches) matchedFields += 1;
      }
      if (testCase.clarificationExpected) {
        clarificationCases += 1;
        if (Boolean(extracted.clarificationQuestion) ||
            extracted.targetAmountMajor === null || extracted.targetDate === null) {
          clarificationTruePositives += 1;
        }
      }
      observations.push({
        intent: extracted.intent,
        matched: Object.keys(testCase.expected).filter((field) =>
          Object.is(extracted[field as keyof PlanningIntentDraft], testCase.expected[field as keyof PlanningIntentDraft]),
        ).length,
        expected: Object.keys(testCase.expected).length,
        clarification: Boolean(extracted.clarificationQuestion),
      });
    }

    const fieldAccuracy = expectedFields === 0 ? 0 : matchedFields / expectedFields;
    const clarificationRecall = clarificationCases === 0 ? 1 : clarificationTruePositives / clarificationCases;
    // A small, versioned synthetic suite is a regression signal, not a claim of universal language coverage.
    expect({ fieldAccuracy, clarificationRecall, observations }).toMatchObject({
      fieldAccuracy: expect.any(Number),
      clarificationRecall: expect.any(Number),
    });
    expect(fieldAccuracy, JSON.stringify(observations)).toBeGreaterThanOrEqual(0.8);
    expect(clarificationRecall, JSON.stringify(observations)).toBe(1);
  }, 600_000);
});
