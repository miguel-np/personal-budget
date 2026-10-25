import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('uses loopback-only defaults and EUR', () => {
    const config = loadConfig({});
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3000);
    expect(config.actualServerURL).toBe('http://127.0.0.1:5006');
    expect(config.budgetCurrency).toBe('EUR');
    expect(config.allowedOrigins).toContain('http://127.0.0.1:5173');
  });
  it('rejects binding to a non-loopback interface', () => {
    expect(() => loadConfig({ APP_HOST: '0.0.0.0' })).toThrow();
  });
  it('rejects remote Actual server URLs', () => {
    expect(() => loadConfig({ ACTUAL_SERVER_URL: 'https://actual.example.com' })).toThrow();
  });
  it('rejects non-loopback browser origins and URL paths', () => {
    expect(() => loadConfig({ APP_ALLOWED_ORIGINS: 'https://attacker.example' })).toThrow();
    expect(() => loadConfig({ APP_ALLOWED_ORIGINS: 'http://localhost:5173/path' })).toThrow();
  });
  it('ignores empty optional password and budget identifiers', () => {
    const config = loadConfig({ ACTUAL_SERVER_PASSWORD: '', ACTUAL_BUDGET_ID: '   ' });
    expect(config.actualServerPassword).toBeUndefined();
    expect(config.actualBudgetId).toBeUndefined();
  });
  it('rejects currencies that are not three uppercase letters', () => {
    expect(() => loadConfig({ BUDGET_CURRENCY: 'eur' })).toThrow();
  });
});
