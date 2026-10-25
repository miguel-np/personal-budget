import { z } from 'zod';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const DEFAULT_ALLOWED_ORIGINS = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:4173',
  'http://localhost:4173',
  'http://127.0.0.1:3000',
  'http://localhost:3000',
];

function isLoopbackUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return LOCAL_HOSTS.has(parsed.hostname) && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
  } catch {
    return false;
  }
}

function parseAllowedOrigins(value: string): readonly string[] {
  const origins = value.split(',').map((origin) => origin.trim()).filter(Boolean);
  if (origins.length === 0) throw new Error('APP_ALLOWED_ORIGINS must contain at least one localhost origin.');
  for (const origin of origins) {
    if (!isLoopbackUrl(origin)) throw new Error('APP_ALLOWED_ORIGINS may contain localhost origins only.');
    const parsed = new URL(origin);
    if (parsed.origin !== origin) throw new Error('APP_ALLOWED_ORIGINS entries must be exact origins without paths.');
  }
  return [...new Set(origins)];
}

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_HOST: z.string().default('127.0.0.1').refine((host) => LOCAL_HOSTS.has(host), {
    message: 'APP_HOST must be localhost, 127.0.0.1 or ::1.',
  }),
  APP_PORT: z.coerce.number().int().min(1024).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ACTUAL_SERVER_URL: z.string().url().default('http://127.0.0.1:5006').refine(isLoopbackUrl, {
    message: 'ACTUAL_SERVER_URL must target a loopback host for local-only deployments.',
  }),
  ACTUAL_SERVER_PASSWORD: z.string().optional(),
  OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:11434').refine(isLoopbackUrl, { message: 'OLLAMA_BASE_URL must target a loopback host for local-only deployments.' }),
  OLLAMA_MODEL: z.preprocess((value) => (value === '' ? undefined : value), z.string().trim().min(1).max(128).optional()),
  AI_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  OLLAMA_REQUEST_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(180).default(120),
  AI_MAX_CONTEXT_CHARS: z.coerce.number().int().min(512).max(8_000).default(4_000),
  ACTUAL_BUDGET_ID: z.string().trim().max(128).optional(),
  ACTUAL_DATA_DIR: z.string().trim().min(1).max(1024).default('./.local/actual-api'),
  BUDGET_CURRENCY: z.string().regex(/^[A-Z]{3}$/).default('EUR'),
  APP_ALLOWED_ORIGINS: z.string().default(DEFAULT_ALLOWED_ORIGINS.join(',')),
});

export interface AppConfig {
  readonly environment: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  readonly actualServerURL: string;
  readonly actualServerPassword?: string;
  readonly ollamaBaseURL: string;
  readonly ollamaModel?: string;
  readonly aiEnabled: boolean;
  readonly ollamaTimeoutMs: number;
  readonly aiMaxContextChars: number;
  readonly actualBudgetId?: string;
  readonly actualDataDir: string;
  readonly budgetCurrency: string;
  readonly allowedOrigins: readonly string[];
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvironmentSchema.parse(environment);
  const normalizedBudgetId = parsed.ACTUAL_BUDGET_ID?.trim();
  const normalizedPassword = parsed.ACTUAL_SERVER_PASSWORD;
  const normalizedModel = parsed.OLLAMA_MODEL?.trim();

  return {
    environment: parsed.NODE_ENV,
    host: parsed.APP_HOST,
    port: parsed.APP_PORT,
    logLevel: parsed.LOG_LEVEL,
    actualServerURL: parsed.ACTUAL_SERVER_URL,
    ...(normalizedPassword ? { actualServerPassword: normalizedPassword } : {}),
    ollamaBaseURL: parsed.OLLAMA_BASE_URL,
    ...(normalizedModel ? { ollamaModel: normalizedModel } : {}),
    aiEnabled: parsed.AI_ENABLED,
    ollamaTimeoutMs: parsed.OLLAMA_REQUEST_TIMEOUT_SECONDS * 1_000,
    aiMaxContextChars: parsed.AI_MAX_CONTEXT_CHARS,
    ...(normalizedBudgetId ? { actualBudgetId: normalizedBudgetId } : {}),
    actualDataDir: parsed.ACTUAL_DATA_DIR,
    budgetCurrency: parsed.BUDGET_CURRENCY,
    allowedOrigins: parseAllowedOrigins(parsed.APP_ALLOWED_ORIGINS),
  };
}
