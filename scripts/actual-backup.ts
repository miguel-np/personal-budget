import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, basename, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { checksum, checksumSidecarContents, makeBackupFilename, parseRetentionDays, validateArchiveEntryTypes, validateArchiveMembers } from './backup-restore.js';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(root, process.env.ACTUAL_SERVER_DATA_DIR ?? '.local/actual-server-data');
const backupDir = resolve(root, process.env.BACKUP_DIR ?? '.local/backups');

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
async function verifyArchive(archive: string): Promise<void> {
  const info = await stat(archive).catch(() => null);
  if (!info?.isFile()) throw new Error('Backup archive does not exist.');
  const sidecar = await readFile(archive + '.sha256', 'utf8');
  const [expected, namedFile] = sidecar.trim().split(/\s+/);
  if (!expected || namedFile !== basename(archive) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Backup checksum file is invalid.');
  const actual = await checksumFile(archive);
  if (actual !== expected) throw new Error('Backup checksum verification failed.');
  await archiveMembers(archive);
}
async function pruneOldBackups(): Promise<void> {
  const retentionDays = parseRetentionDays(process.env.BACKUP_RETENTION_DAYS);
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const entries = await readdir(backupDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/^actual-server-.*\.tar\.gz$/.test(entry.name)) continue;
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
  await mkdir(backupDir, { recursive: true });
  const archive = join(backupDir, makeBackupFilename());
  await command('docker', ['compose', 'stop', 'actual']);
  let archiveCreated = false;
  try {
    // Create exclusively with private permissions before tar writes any financial data.
    await writeFile(archive, '', { flag: 'wx', mode: 0o600 });
    archiveCreated = true;
    await command('tar', ['-czf', archive, '-C', dirname(dataDir), basename(dataDir)]);
    await chmod(archive, 0o600);
    await archiveMembers(archive);
    const digest = await checksumFile(archive);
    await writeFile(archive + '.sha256', checksumSidecarContents(archive, digest), { mode: 0o600 });
  } catch (error) {
    if (archiveCreated) {
      await rm(archive, { force: true });
      await rm(archive + '.sha256', { force: true });
    }
    throw error;
  } finally {
    await command('docker', ['compose', 'start', 'actual']);
  }
  await verifyArchive(archive);
  await pruneOldBackups();
  return archive;
}
async function restore(archiveInput: string): Promise<{ safetyCopy?: string }> {
  if (!archiveInput) throw new Error('Pass the archive path: npm run restore:actual -- /path/to/backup.tar.gz');
  const archive = resolve(root, archiveInput);
  await verifyArchive(archive);
  await mkdir(dirname(dataDir), { recursive: true });
  const stage = await mkdtemp(join(dirname(dataDir), '.actual-restore-stage-'));
  const safetyCopy = dataDir + '.pre-restore-' + new Date().toISOString().replace(/[-:.]/g, '');
  let stopped = false;
  let oldMoved = false;
  let replacementMoved = false;
  try {
    await command('docker', ['compose', 'stop', 'actual']);
    stopped = true;
    await command('tar', ['-xzf', archive, '-C', stage]);
    const candidate = join(stage, basename(dataDir));
    await assertDirectory(candidate);
    const current = await stat(dataDir).catch(() => null);
    if (current) { await rename(dataDir, safetyCopy); oldMoved = true; }
    await rename(candidate, dataDir);
    replacementMoved = true;
    try {
      await command('docker', ['compose', 'start', 'actual']);
      stopped = false;
    } catch (error) {
      if (replacementMoved) await rm(dataDir, { recursive: true, force: true });
      if (oldMoved) await rename(safetyCopy, dataDir);
      await command('docker', ['compose', 'start', 'actual']).catch(() => undefined);
      stopped = false;
      throw error;
    }
  } catch (error) {
    if (stopped) await command('docker', ['compose', 'start', 'actual']).catch(() => undefined);
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return oldMoved ? { safetyCopy } : {};
}
async function main(): Promise<void> {
  const action = process.argv[2];
  if (action === 'backup') {
    const archive = await backup();
    process.stdout.write('Verified backup created: ' + archive + '\n');
    return;
  }
  if (action === 'restore') {
    const result = await restore(process.argv[3] ?? '');
    process.stdout.write('Restore complete; verify account, category, and transaction counts before use.\n');
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
