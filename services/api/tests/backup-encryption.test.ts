import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { decryptBackupFile, encryptBackupFile, loadOrCreateBackupKey, readBackupKey } from '../../../scripts/backup-encryption.js';

const tempDirs: string[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'personal-budget-backup-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('authenticated backup encryption', () => {
  it('round-trips synthetic bytes and stores a separate 32-byte key', async () => {
    const dir = await fixture();
    const keyPath = join(dir, 'secrets', 'backup.key');
    const input = join(dir, 'synthetic.tar.gz');
    const encrypted = join(dir, 'synthetic.tar.gz.enc');
    const decrypted = join(dir, 'roundtrip.tar.gz');
    const expected = Buffer.from('synthetic financial inventory; no real data');
    await writeFile(input, expected);
    const key = await loadOrCreateBackupKey(keyPath);
    expect(key).toHaveLength(32);
    expect((await stat(keyPath)).mode & 0o077).toBe(0);
    await encryptBackupFile(input, encrypted, key);
    expect((await readFile(encrypted)).includes(expected)).toBe(false);
    await decryptBackupFile(encrypted, decrypted, key);
    expect(await readFile(decrypted)).toEqual(expected);
    expect(await readBackupKey(keyPath)).toEqual(key);
  });

  it('rejects a wrong key and removes unauthenticated plaintext output', async () => {
    const dir = await fixture();
    const input = join(dir, 'synthetic.tar.gz');
    const encrypted = join(dir, 'synthetic.tar.gz.enc');
    const decrypted = join(dir, 'must-not-remain.tar.gz');
    await writeFile(input, randomBytes(512));
    await encryptBackupFile(input, encrypted, randomBytes(32));
    await expect(decryptBackupFile(encrypted, decrypted, randomBytes(32))).rejects.toThrow(/authentication failed/i);
    await expect(stat(decrypted)).rejects.toThrow();
  });

  it('rejects altered and truncated ciphertext before it can be used', async () => {
    const dir = await fixture();
    const input = join(dir, 'synthetic.tar.gz');
    const encrypted = join(dir, 'synthetic.tar.gz.enc');
    await writeFile(input, Buffer.from('synthetic data'));
    const key = randomBytes(32);
    await encryptBackupFile(input, encrypted, key);
    const contents = await readFile(encrypted);
    const altered = Buffer.from(contents);
    altered[altered.length - 20] = (altered[altered.length - 20] ?? 0) ^ 1;
    await writeFile(encrypted, altered);
    await expect(decryptBackupFile(encrypted, join(dir, 'altered.out'), key)).rejects.toThrow(/authentication failed/i);
    await writeFile(encrypted, contents.subarray(0, 20));
    await expect(decryptBackupFile(encrypted, join(dir, 'truncated.out'), key)).rejects.toThrow(/truncated/i);
  });

  it('does not silently generate a new key during restore', async () => {
    const dir = await fixture();
    await expect(readBackupKey(join(dir, 'missing.key'))).rejects.toThrow(/missing/i);
  });
});
