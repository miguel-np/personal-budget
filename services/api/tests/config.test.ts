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
  it('keeps Ollama disabled and loopback-only by default', () => {
    const config = loadConfig({});
    expect(config.aiEnabled).toBe(false);
    expect(config.ollamaBaseURL).toBe('http://127.0.0.1:11434');
    expect(config.ollamaTimeoutMs).toBe(120_000);
  });
  it('keeps hybrid category classification opt-in and allows disabling payee names', () => {
    expect(loadConfig({})).toMatchObject({
      aiCategoryClassificationEnabled: false,
      aiCategoryClassificationIncludePayee: true,
    });
    expect(loadConfig({
      AI_ENABLED: 'true',
      AI_CATEGORY_CLASSIFICATION_ENABLED: 'true',
      AI_CATEGORY_CLASSIFICATION_INCLUDE_PAYEE: 'false',
    })).toMatchObject({
      aiEnabled: true,
      aiCategoryClassificationEnabled: true,
      aiCategoryClassificationIncludePayee: false,
    });
    expect(() => loadConfig({ AI_CATEGORY_CLASSIFICATION_ENABLED: 'yes' })).toThrow();
  });

  it('rejects remote Ollama endpoints and invalid timeout values', () => {
    expect(() => loadConfig({ OLLAMA_BASE_URL: 'https://ollama.example.com' })).toThrow();
    expect(() => loadConfig({ OLLAMA_REQUEST_TIMEOUT_SECONDS: '0' })).toThrow();
    expect(() => loadConfig({ AI_MAX_CONTEXT_CHARS: '9000' })).toThrow();
  });
  it('trims and validates an explicitly configured Ollama model', () => {
    expect(loadConfig({ AI_ENABLED: 'true', OLLAMA_MODEL: ' llama3.2 ' })).toMatchObject({ aiEnabled: true, ollamaModel: 'llama3.2' });
    expect(() => loadConfig({ AI_ENABLED: 'yes' })).toThrow();
  });
  it('treats an empty Ollama model from the .env template as unset', () => {
    const config = loadConfig({ OLLAMA_MODEL: '' });
    expect(config.ollamaModel).toBeUndefined();
  });
  it('keeps web search disabled by default and validates its bounded provider settings', () => {
    expect(loadConfig({})).toMatchObject({
      webSearchEnabled: false,
      webSearchBaseURL: 'http://127.0.0.1:8080',
      webSearchTimeoutMs: 8_000,
      webSearchMaxResults: 5,
      webSearchMaxQueryChars: 300,
      webSearchMaxResponseBytes: 131_072,
    });
    expect(loadConfig({
      WEB_SEARCH_ENABLED: 'true',
      WEB_SEARCH_BASE_URL: 'https://search.example.org',
      WEB_SEARCH_TIMEOUT_SECONDS: '12',
      WEB_SEARCH_MAX_RESULTS: '8',
    })).toMatchObject({ webSearchEnabled: true, webSearchTimeoutMs: 12_000, webSearchMaxResults: 8 });
    expect(() => loadConfig({ WEB_SEARCH_ENABLED: 'yes' })).toThrow();
    expect(() => loadConfig({ WEB_SEARCH_BASE_URL: 'http://search.example.org' })).toThrow();
    expect(() => loadConfig({ WEB_SEARCH_BASE_URL: 'http://169.254.169.254' })).toThrow();
    expect(() => loadConfig({ WEB_SEARCH_TIMEOUT_SECONDS: '31' })).toThrow();
    expect(() => loadConfig({ WEB_SEARCH_MAX_RESULTS: '9' })).toThrow();
    expect(() => loadConfig({ WEB_SEARCH_MAX_QUERY_CHARS: '10' })).toThrow();
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
