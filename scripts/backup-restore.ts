import { createHash } from 'node:crypto';
import { basename } from 'node:path';

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
  return 'actual-server-' + stamp + '.tar.gz';
}
export function checksum(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}
export function checksumSidecarContents(archivePath: string, digest: string): string {
  return digest + '  ' + basename(archivePath) + '\n';
}
