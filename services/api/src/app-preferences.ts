import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

export const AppPreferencesSchema = z.object({
  theme: z.enum(['system', 'dark', 'light']).default('system'),
  locale: z.enum(['es-ES', 'en-GB']).default('es-ES'),
}).strict();

export type AppPreferences = z.infer<typeof AppPreferencesSchema>;

export function defaultAppPreferences(): AppPreferences {
  return { theme: 'system', locale: 'es-ES' };
}

export async function readAppPreferences(dataDirectory: string): Promise<AppPreferences> {
  const path = resolve(dataDirectory, 'app-preferences.json');
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return defaultAppPreferences();
    throw error;
  }
  return AppPreferencesSchema.parse(JSON.parse(contents) as unknown);
}

export async function writeAppPreferences(dataDirectory: string, preferences: AppPreferences): Promise<void> {
  const parsed = AppPreferencesSchema.parse(preferences);
  const path = resolve(dataDirectory, 'app-preferences.json');
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
