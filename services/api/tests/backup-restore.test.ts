import { describe, expect, it } from 'vitest';
import {
  APP_STATE_FILE_NAMES, checksum, checksumSidecarContents, isSafeArchiveMember, makeBackupFilename,
  parseRetentionDays, validateArchiveEntryTypes, validateArchiveMembers, validateBackupManifest,
} from '../../../scripts/backup-restore.js';

const validManifest = () => ({
  format: 'personal-budget-backup',
  schemaVersion: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  actualServerData: { root: 'actual-server-data' },
  personalBudgetState: {
    root: 'personal-budget-state',
    files: [{ name: 'planning-data.json', sizeBytes: 12, sha256: 'a'.repeat(64) }],
  },
  exclusions: ['.env and backup keys'],
});

describe('Actual and Personal Budget backup safety helpers', () => {
  it('only accepts archive members rooted in the bundle directory', () => {
    expect(isSafeArchiveMember('personal-budget-backup/', 'personal-budget-backup')).toBe(true);
    expect(isSafeArchiveMember('personal-budget-backup/actual-server-data/accounts.json', 'personal-budget-backup')).toBe(true);
    expect(isSafeArchiveMember('personal-budget-backup/personal-budget-state/planning-data.json', 'personal-budget-backup')).toBe(true);
    expect(isSafeArchiveMember('../.env', 'personal-budget-backup')).toBe(false);
    expect(isSafeArchiveMember('personal-budget-backup/../../.env', 'personal-budget-backup')).toBe(false);
    expect(isSafeArchiveMember('/etc/passwd', 'personal-budget-backup')).toBe(false);
    expect(isSafeArchiveMember('other-directory/file', 'personal-budget-backup')).toBe(false);
  });

  it('rejects empty, unsafe and out-of-root archive listings', () => {
    expect(() => validateArchiveMembers([], 'personal-budget-backup')).toThrow();
    expect(() => validateArchiveMembers(['personal-budget-backup/data', '../.env'], 'personal-budget-backup')).toThrow();
    expect(() => validateArchiveMembers(['unrelated/file'], 'personal-budget-backup')).toThrow();
  });

  it('only permits regular files and directories in a restore archive', () => {
    validateArchiveEntryTypes([
      'drwxr-xr-x root/root 0 2026-11-01 12:00 personal-budget-backup/',
      '-rw------- root/root 128 2026-11-01 12:00 personal-budget-backup/actual-server-data/server.sqlite',
    ]);
    expect(() => validateArchiveEntryTypes([])).toThrow(/regular files and directories/i);
    expect(() => validateArchiveEntryTypes([
      'drwxr-xr-x root/root 0 2026-11-01 12:00 personal-budget-backup/',
      'lrwxrwxrwx root/root 0 2026-11-01 12:00 personal-budget-backup/link -> ../../.env',
    ])).toThrow(/regular files and directories/i);
    expect(() => validateArchiveEntryTypes([
      'hrw-r--r-- root/root 0 2026-11-01 12:00 personal-budget-backup/hardlink link to ../../.env',
    ])).toThrow(/regular files and directories/i);
  });

  it('accepts a versioned manifest with an explicit whitelist of app-owned state', () => {
    expect(() => validateBackupManifest(validManifest())).not.toThrow();
    expect(APP_STATE_FILE_NAMES).toContain('planning-data.json');
    expect(APP_STATE_FILE_NAMES).toContain('periodic-reviews.json');
    expect(APP_STATE_FILE_NAMES).toContain('financial-actions.json');
    expect(APP_STATE_FILE_NAMES).toHaveLength(7);
  });

  it('rejects unsupported versions, unexpected fields, duplicate files and invalid checksums', () => {
    expect(() => validateBackupManifest({ ...validManifest(), schemaVersion: 2 })).toThrow(/version/i);
    expect(() => validateBackupManifest({ ...validManifest(), unexpected: true })).toThrow(/fields/i);
    const duplicate = validManifest();
    duplicate.personalBudgetState.files.push({ ...duplicate.personalBudgetState.files[0]! });
    expect(() => validateBackupManifest(duplicate)).toThrow(/duplicate/i);
    const invalidDigest = validManifest();
    invalidDigest.personalBudgetState.files[0]!.sha256 = 'not-a-checksum';
    expect(() => validateBackupManifest(invalidDigest)).toThrow(/invalid/i);
    const unownedFile = validManifest();
    unownedFile.personalBudgetState.files[0]!.name = 'credentials.json' as never;
    expect(() => validateBackupManifest(unownedFile)).toThrow(/invalid/i);
  });

  it('validates retention configuration and defaults safely', () => {
    expect(parseRetentionDays(undefined)).toBe(30);
    expect(parseRetentionDays('90')).toBe(90);
    expect(() => parseRetentionDays('0')).toThrow();
    expect(() => parseRetentionDays('3651')).toThrow();
    expect(() => parseRetentionDays('30 days')).toThrow();
  });

  it('creates checksum metadata and stable UTC names', () => {
    const data = new TextEncoder().encode('synthetic backup');
    expect(checksum(data)).toMatch(/^[a-f0-9]{64}$/);
    expect(checksumSidecarContents('/private/backups/test.tar.gz', checksum(data))).toContain('test.tar.gz');
    expect(makeBackupFilename(new Date('2026-11-01T12:00:00.000Z'))).toBe('personal-budget-20261101T120000Z.tar.gz');
  });
});
