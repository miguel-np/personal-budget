import { createHash } from 'node:crypto';
import { basename } from 'node:path';

export const APP_STATE_FILE_NAMES = [
  'account-scope-preferences.json',
  'app-preferences.json',
  'currency-preferences.json',
  'financial-intelligence-state.json',
  'periodic-reviews.json',
  'planning-data.json',
] as const;

export interface BackupManifestFile {
  readonly name: typeof APP_STATE_FILE_NAMES[number];
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface BackupManifest {
  readonly format: 'personal-budget-backup';
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly actualServerData: { readonly root: 'actual-server-data' };
  readonly personalBudgetState: {
    readonly root: 'personal-budget-state';
    readonly files: readonly BackupManifestFile[];
  };
  readonly exclusions: readonly string[];
}

export function validateBackupManifest(value: unknown): asserts value is BackupManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Backup manifest must be an object.');
  }
  const manifest = value as Record<string, unknown>;
  const expectedKeys = ['actualServerData', 'createdAt', 'exclusions', 'format', 'personalBudgetState', 'schemaVersion'];
  if (Object.keys(manifest).sort().join('|') !== expectedKeys.join('|')) {
    throw new Error('Backup manifest contains missing or unsupported fields.');
  }
  if (manifest.format !== 'personal-budget-backup' || manifest.schemaVersion !== 1 ||
      typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new Error('Backup manifest format or version is not supported.');
  }
  const actual = manifest.actualServerData;
  const state = manifest.personalBudgetState;
  if (typeof actual !== 'object' || actual === null || Array.isArray(actual) ||
      (actual as Record<string, unknown>).root !== 'actual-server-data' ||
      Object.keys(actual).sort().join('|') !== 'root') {
    throw new Error('Backup manifest does not identify the Actual data directory.');
  }
  if (typeof state !== 'object' || state === null || Array.isArray(state) ||
      (state as Record<string, unknown>).root !== 'personal-budget-state' ||
      !Array.isArray((state as Record<string, unknown>).files) ||
      Object.keys(state).sort().join('|') !== 'files|root') {
    throw new Error('Backup manifest does not identify Personal Budget state.');
  }
  const files = (state as Record<string, unknown>).files as unknown[];
  const seen = new Set<string>();
  for (const entry of files) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('Backup manifest contains an invalid state file entry.');
    }
    const file = entry as Record<string, unknown>;
    if (Object.keys(file).sort().join('|') !== 'name|sha256|sizeBytes' ||
        typeof file.name !== 'string' ||
        !(APP_STATE_FILE_NAMES as readonly string[]).includes(file.name) ||
        seen.has(file.name) ||
        typeof file.sizeBytes !== 'number' || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 ||
        typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error('Backup manifest contains an invalid or duplicate state file entry.');
    }
    seen.add(file.name);
  }
  const exclusions = manifest.exclusions;
  if (!Array.isArray(exclusions) || exclusions.length > 20 ||
      exclusions.some((entry) => typeof entry !== 'string' || entry.length === 0 || entry.length > 500)) {
    throw new Error('Backup manifest exclusions are invalid.');
  }
}

export function isSafeArchiveMember(member: string, expectedRoot: string): boolean {
  if (!member || member.startsWith('/') || member.startsWith('\\') || /^[A-Za-z]:/.test(member)) return false;
  if (member.includes('\\')) return false;
  const parts = member.split('/').filter((part) => part.length > 0 && part !== '.');
  if (parts.length === 0 || parts.some((part) => part === '..')) return false;
  return parts[0] === expectedRoot;
}
export function validateArchiveMembers(members: readonly string[], expectedRoot: string): void {
  if (members.length === 0 || !members.some((member) => {
    const normalized = member.replace(/\/+$/, '');
    return normalized === expectedRoot || normalized.startsWith(expectedRoot + '/');
  })) throw new Error('Backup archive does not contain the expected data directory.');
  if (members.some((member) => !isSafeArchiveMember(member, expectedRoot))) {
    throw new Error('Backup archive contains an unsafe path.');
  }
}
export function parseRetentionDays(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 30;
  if (!/^\d+$/.test(value.trim())) throw new Error('BACKUP_RETENTION_DAYS must be an integer from 1 to 3650.');
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days < 1 || days > 3_650) {
    throw new Error('BACKUP_RETENTION_DAYS must be an integer from 1 to 3650.');
  }
  return days;
}
export function makeBackupFilename(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return 'personal-budget-' + stamp + '.tar.gz';
}
export function checksum(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}
export function checksumSidecarContents(archivePath: string, digest: string): string {
  return digest + '  ' + basename(archivePath) + '\n';
}

export function validateArchiveEntryTypes(entries: readonly string[]): void {
  if (entries.length === 0 || entries.some((entry) => !/^[-d]/.test(entry))) {
    throw new Error('Backup archive may contain only regular files and directories.');
  }
}
