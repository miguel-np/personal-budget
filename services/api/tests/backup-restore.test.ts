import { describe, expect, it } from 'vitest';
import { checksum, checksumSidecarContents, isSafeArchiveMember, makeBackupFilename, parseRetentionDays, validateArchiveMembers } from '../../scripts/backup-restore.js';

describe('Actual backup and restore safety helpers', () => {
  it('only accepts files rooted in the expected data directory', () => {
    expect(isSafeArchiveMember('actual-server-data/', 'actual-server-data')).toBe(true);
    expect(isSafeArchiveMember('actual-server-data/accounts.json', 'actual-server-data')).toBe(true);
    expect(isSafeArchiveMember('../.env', 'actual-server-data')).toBe(false);
    expect(isSafeArchiveMember('actual-server-data/../../.env', 'actual-server-data')).toBe(false);
    expect(isSafeArchiveMember('/etc/passwd', 'actual-server-data')).toBe(false);
    expect(isSafeArchiveMember('other-directory/file', 'actual-server-data')).toBe(false);
  });
  it('rejects empty or unsafe archive listings', () => {
    expect(() => validateArchiveMembers([], 'actual-server-data')).toThrow();
    expect(() => validateArchiveMembers(['actual-server-data/data', '../.env'], 'actual-server-data')).toThrow();
    expect(() => validateArchiveMembers(['unrelated/file'], 'actual-server-data')).toThrow();
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
    expect(makeBackupFilename(new Date('2026-10-25T12:00:00.000Z'))).toBe('actual-server-20261025T120000Z.tar.gz');
  });
});
