import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppPreferencesSchema, defaultAppPreferences, readAppPreferences, writeAppPreferences } from '../src/app-preferences.js';

const directories: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'personal-budget-app-preferences-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('local app preferences', () => {
  it('defaults to system appearance and Spanish regional formatting', async () => {
    const directory = await temporaryDirectory();
    await expect(readAppPreferences(directory)).resolves.toEqual(defaultAppPreferences());
  });

  it('writes valid preferences atomically with restrictive file permissions', async () => {
    const directory = await temporaryDirectory();
    await writeAppPreferences(directory, { theme: 'light', locale: 'en-GB' });
    await expect(readAppPreferences(directory)).resolves.toEqual({ theme: 'light', locale: 'en-GB' });
    const info = await stat(join(directory, 'app-preferences.json'));
    expect(info.isFile()).toBe(true);
    if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o600);
    expect(await readFile(join(directory, 'app-preferences.json'), 'utf8')).toContain('"locale": "en-GB"');
  });

  it('rejects unsupported keys and locale/theme values instead of silently persisting them', () => {
    expect(AppPreferencesSchema.safeParse({ theme: 'light', locale: 'es-ES', password: 'never-store-me' }).success).toBe(false);
    expect(AppPreferencesSchema.safeParse({ theme: 'bright', locale: 'es-ES' }).success).toBe(false);
    expect(AppPreferencesSchema.safeParse({ theme: 'dark', locale: 'fr-FR' }).success).toBe(false);
  });
});
