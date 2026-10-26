import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('PBBKENC1', 'ascii');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HEADER_BYTES = MAGIC.length + NONCE_BYTES;

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new Error('Backup encryption key must contain exactly 32 bytes.');
}

export async function readBackupKey(path: string): Promise<Buffer> {
  const info = await lstat(path).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink()) {
    throw new Error('Backup encryption key is missing or is not a regular file. Restore the original key file before continuing.');
  }
  if ((info.mode & 0o077) !== 0) await chmod(path, 0o600);
  const key = await readFile(path);
  assertKey(key);
  return key;
}

/** Creates a random key on first backup; the key is always stored separately from the archive. */
export async function loadOrCreateBackupKey(path: string): Promise<Buffer> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(path, 'wx', 0o600);
    const key = randomBytes(KEY_BYTES);
    try {
      await handle.writeFile(key);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(path, 0o600).catch(() => undefined);
    return key;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    return readBackupKey(path);
  }
}

export async function encryptBackupFile(input: string, output: string, key: Buffer): Promise<void> {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  try {
    await writeFile(output, Buffer.concat([MAGIC, nonce]), { flag: 'wx', mode: 0o600 });
    await pipeline(
      createReadStream(input),
      cipher,
      createWriteStream(output, { flags: 'a', mode: 0o600 }),
    );
    await appendFile(output, cipher.getAuthTag(), { mode: 0o600 });
    await chmod(output, 0o600).catch(() => undefined);
  } catch (error) {
    await rm(output, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function decryptBackupFile(input: string, output: string, key: Buffer): Promise<void> {
  assertKey(key);
  const info = await stat(input);
  if (!info.isFile() || info.size < HEADER_BYTES + TAG_BYTES) {
    throw new Error('Encrypted backup is truncated or invalid.');
  }

  const handle = await open(input, 'r');
  let header: Buffer;
  let tag: Buffer;
  try {
    header = Buffer.alloc(HEADER_BYTES);
    tag = Buffer.alloc(TAG_BYTES);
    const headerRead = await handle.read(header, 0, HEADER_BYTES, 0);
    const tagRead = await handle.read(tag, 0, TAG_BYTES, info.size - TAG_BYTES);
    if (headerRead.bytesRead !== HEADER_BYTES || tagRead.bytesRead !== TAG_BYTES) {
      throw new Error('Encrypted backup is truncated or invalid.');
    }
  } finally {
    await handle.close();
  }

  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Encrypted backup format is not recognized.');
  const nonce = header.subarray(MAGIC.length);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      createReadStream(input, { start: HEADER_BYTES, end: info.size - TAG_BYTES - 1 }),
      decipher,
      createWriteStream(output, { flags: 'wx', mode: 0o600 }),
    );
    await chmod(output, 0o600).catch(() => undefined);
  } catch {
    await rm(output, { force: true }).catch(() => undefined);
    throw new Error('Encrypted backup authentication failed; the key may be wrong or the archive may have been altered.');
  }
}
