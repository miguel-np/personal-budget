import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, basename, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { checksumSidecarContents, makeBackupFilename, parseRetentionDays, validateArchiveEntryTypes, validateArchiveMembers } from './backup-restore.js';
import { decryptBackupFile, encryptBackupFile, loadOrCreateBackupKey, readBackupKey } from './backup-encryption.js';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(root, process.env.ACTUAL_SERVER_DATA_DIR ?? '.local/actual-server-data');
const backupDir = resolve(root, process.env.BACKUP_DIR ?? '.local/backups');
const keyFile = resolve(root, process.env.BACKUP_ENCRYPTION_KEY_FILE ?? '.local/backup-key.bin');

async function command(program: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(program, args, { cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
}
async function checksumFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function assertDirectory(path: string): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) throw new Error('Expected data directory is missing.');
}
async function archiveMembers(archive: string): Promise<string[]> {
  const [listing, detailedListing] = await Promise.all([
    command('tar', ['-tzf', archive]),
    command('tar', ['-tvzf', archive]),
  ]);
  const members = listing.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const entries = detailedListing.stdout.split(/\r?\n/).filter(Boolean);
  validateArchiveMembers(members, basename(dataDir));
  validateArchiveEntryTypes(entries);
  return members;
}
async function verifyArchive(archive: string, key: Buffer): Promise<void> {
  const info = await stat(archive).catch(() => null);
  if (!info?.isFile()) throw new Error('Encrypted backup archive does not exist.');
  const sidecar = await readFile(archive + '.sha256', 'utf8');
  const [expected, namedFile] = sidecar.trim().split(/\s+/);
  if (!expected || namedFile !== basename(archive) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Backup checksum file is invalid.');
  const actual = await checksumFile(archive);
  if (actual !== expected) throw new Error('Backup checksum verification failed.');

  const stage = await mkdtemp(join(dirname(archive), '.verify-'));
  const plaintext = join(stage, 'verified.tar.gz');
  try {
    await decryptBackupFile(archive, plaintext, key);
    await archiveMembers(plaintext);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
async function pruneOldBackups(): Promise<void> {
  const retentionDays = parseRetentionDays(process.env.BACKUP_RETENTION_DAYS);
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const entries = await readdir(backupDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/^actual-server-.*\.tar\.gz\.enc$/.test(entry.name)) continue;
    const archive = join(backupDir, entry.name);
    const info = await stat(archive);
    if (info.mtimeMs < cutoff) {
      await rm(archive, { force: true });
      await rm(archive + '.sha256', { force: true });
    }
  }
}
async function backup(): Promise<string> {
  await assertDirectory(dataDir);
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  // Validate or generate the key before stopping Actual, so key errors cannot interrupt service.
  const key = await loadOrCreateBackupKey(keyFile);
  const archive = join(backupDir, makeBackupFilename().replace(/\.tar\.gz$/, '.tar.gz.enc'));
  const stage = await mkdtemp(join(backupDir, '.backup-stage-'));
  const plaintext = join(stage, 'actual-server.tar.gz');
  let serviceStopped = false;
  try {
    await command('docker', ['compose', 'stop', 'actual']);
    serviceStopped = true;
    await writeFile(plaintext, '', { flag: 'wx', mode: 0o600 });
    await command('tar', ['-czf', plaintext, '-C', dirname(dataDir), basename(dataDir)]);
    await chmod(plaintext, 0o600).catch(() => undefined);
    await archiveMembers(plaintext);
    await encryptBackupFile(plaintext, archive, key);
    await chmod(archive, 0o600).catch(() => undefined);
    const digest = await checksumFile(archive);
    await writeFile(archive + '.sha256', checksumSidecarContents(archive, digest), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await rm(archive, { force: true }).catch(() => undefined);
    await rm(archive + '.sha256', { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    if (serviceStopped) await command('docker', ['compose', 'up', '-d', 'actual']);
  }
  await verifyArchive(archive, key);
  await pruneOldBackups();
  return archive;
}
async function restore(archiveInput: string, confirmed: boolean): Promise<{ safetyCopy?: string }> {
  if (!confirmed) throw new Error('Restoration replaces the current Actual data directory. Pass --confirm-data-restore explicitly after reviewing the backup and accepting possible loss of later data.');
  if (!archiveInput) throw new Error('Pass the encrypted archive path: npm run restore:actual -- /path/to/backup.tar.gz.enc --confirm-data-restore');
  const archive = resolve(root, archiveInput);
  if (!archive.endsWith('.tar.gz.enc')) throw new Error('Restore accepts encrypted .tar.gz.enc backups only.');
  const key = await readBackupKey(keyFile);
  await verifyArchive(archive, key);
  await mkdir(dirname(dataDir), { recursive: true });
  const stage = await mkdtemp(join(dirname(dataDir), '.actual-restore-stage-'));
  const plaintext = join(stage, 'restore.tar.gz');
  const extracted = join(stage, 'extracted');
  await mkdir(extracted, { mode: 0o700 });
  const safetyCopy = dataDir + '.pre-restore-' + new Date().toISOString().replace(/[-:.]/g, '');
  let stopped = false;
  let oldMoved = false;
  let replacementMoved = false;
  try {
    await decryptBackupFile(archive, plaintext, key);
    await command('docker', ['compose', 'stop', 'actual']);
    stopped = true;
    await command('tar', ['-xzf', plaintext, '-C', extracted]);
    const candidate = join(extracted, basename(dataDir));
    await assertDirectory(candidate);
    const current = await stat(dataDir).catch(() => null);
    if (current) { await rename(dataDir, safetyCopy); oldMoved = true; }
    await rename(candidate, dataDir);
    replacementMoved = true;
    try {
      await command('docker', ['compose', 'up', '-d', 'actual']);
      stopped = false;
    } catch (error) {
      if (replacementMoved) await rm(dataDir, { recursive: true, force: true });
      if (oldMoved) await rename(safetyCopy, dataDir);
      await command('docker', ['compose', 'up', '-d', 'actual']).catch(() => undefined);
      stopped = false;
      throw error;
    }
  } catch (error) {
    if (stopped) await command('docker', ['compose', 'up', '-d', 'actual']).catch(() => undefined);
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
  return oldMoved ? { safetyCopy } : {};
}
async function main(): Promise<void> {
  const action = process.argv[2];
  if (action === 'backup') {
    const archive = await backup();
    process.stdout.write('Verified encrypted backup created: ' + archive + '\n');
    return;
  }
  if (action === 'restore') {
    const result = await restore(process.argv[3] ?? '', process.argv.includes('--confirm-data-restore'));
    process.stdout.write('Restore completed from an authenticated encrypted backup; verify account, category, and transaction counts before use.\n');
    if (result.safetyCopy) process.stdout.write('Previous data directory preserved at: ' + result.safetyCopy + '\n');
    return;
  }
  throw new Error('Choose backup or restore.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown error';
    process.stderr.write('Actual backup/restore failed: ' + message + '\n');
    process.exitCode = 1;
  });
}
