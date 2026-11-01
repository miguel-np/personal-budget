import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod, cp, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, basename, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  APP_STATE_FILE_NAMES, checksumSidecarContents, makeBackupFilename, parseRetentionDays,
  validateArchiveEntryTypes, validateArchiveMembers, validateBackupManifest,
} from './backup-restore.js';
import { decryptBackupFile, encryptBackupFile, loadOrCreateBackupKey, readBackupKey } from './backup-encryption.js';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = resolve(root, '.env');
if (await stat(envFile).catch(() => null)) process.loadEnvFile(envFile);

const dataDir = resolve(root, process.env.ACTUAL_SERVER_DATA_DIR ?? '.local/actual-server-data');
const appDataDir = resolve(root, process.env.ACTUAL_DATA_DIR ?? '.local/actual-api');
const backupDir = resolve(root, process.env.BACKUP_DIR ?? '.local/backups');
const keyFile = resolve(root, process.env.BACKUP_ENCRYPTION_KEY_FILE ?? '.local/backup-key.bin');
const apiHost = process.env.APP_HOST ?? '127.0.0.1';
const apiPort = Number(process.env.APP_PORT ?? 3000);
const archiveRoot = 'personal-budget-backup';
const actualRoot = 'actual-server-data';
const appStateRoot = 'personal-budget-state';

interface ManifestFile {
  readonly name: typeof APP_STATE_FILE_NAMES[number];
  readonly sizeBytes: number;
  readonly sha256: string;
}
interface BundleManifest {
  readonly format: 'personal-budget-backup';
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly actualServerData: { readonly root: 'actual-server-data' };
  readonly personalBudgetState: { readonly root: 'personal-budget-state'; readonly files: readonly ManifestFile[] };
  readonly exclusions: readonly string[];
}
interface ExtractedBundle {
  readonly stage: string;
  readonly bundle: string;
  readonly manifest: BundleManifest;
}

async function command(program: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(program, args, { cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
}
async function checksumFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function assertDirectory(path: string, message: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(message);
}
async function pathExists(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch(() => null));
}
function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

/** A backup must not race the API's local atomic JSON writes. Stop the whole runtime first. */
async function assertApiStopped(): Promise<void> {
  if (!Number.isSafeInteger(apiPort) || apiPort < 1024 || apiPort > 65535 ||
      !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(apiHost)) {
    throw new Error('Local API host or port is invalid; backup and restore stopped before touching data.');
  }
  await new Promise<void>((resolvePromise, reject) => {
    const socket = createConnection({ host: apiHost, port: apiPort });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Cannot verify that the Personal Budget API is stopped. Stop npm run start:local/dev:api with Ctrl+C and retry.'));
    }, 1_000);
    timer.unref();
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error('Personal Budget API is still listening. Stop npm run start:local/dev:api with Ctrl+C before backup or restore.'));
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ECONNREFUSED') resolvePromise();
      else reject(new Error('Cannot verify that the Personal Budget API is stopped. Stop the local runtime and retry.'));
    });
  });
}

async function waitForActual(timeoutMs = 60_000): Promise<void> {
  const url = process.env.ACTUAL_SERVER_URL ?? 'http://127.0.0.1:5006';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500), redirect: 'manual' });
      if (response.status < 500) return;
    } catch { /* Actual may still be starting. */ }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error('Actual Budget did not become ready after start.');
}

async function archiveMembers(archive: string): Promise<string[]> {
  const [listing, detailedListing] = await Promise.all([
    command('tar', ['-tzf', archive]),
    command('tar', ['-tvzf', archive]),
  ]);
  const members = listing.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const entries = detailedListing.stdout.split(/\r?\n/).filter(Boolean);
  validateArchiveMembers(members, archiveRoot);
  validateArchiveEntryTypes(entries);
  if (new Set(members).size !== members.length) throw new Error('Backup archive contains duplicate paths.');
  return members;
}

async function hashStateFile(path: string, name: typeof APP_STATE_FILE_NAMES[number]): Promise<ManifestFile> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('App-owned state must be a regular file: ' + name);
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (parsed === null || typeof parsed !== 'object') throw new Error('App-owned state is not a JSON object: ' + name);
  return { name, sizeBytes: info.size, sha256: await checksumFile(path) };
}

async function buildBundle(stage: string): Promise<string> {
  const bundle = join(stage, archiveRoot);
  const actualSnapshot = join(bundle, actualRoot);
  const appSnapshot = join(bundle, appStateRoot);
  await mkdir(bundle, { recursive: true, mode: 0o700 });
  await mkdir(appSnapshot, { recursive: true, mode: 0o700 });
  await assertDirectory(dataDir, 'Actual server data directory is missing or unsafe.');
  await assertDirectory(appDataDir, 'Personal Budget application data directory is missing or unsafe.');
  await cp(dataDir, actualSnapshot, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });

  const files: ManifestFile[] = [];
  for (const name of APP_STATE_FILE_NAMES) {
    const source = join(appDataDir, name);
    const info = await lstat(source).catch((error: unknown) => isMissing(error) ? null : Promise.reject(error));
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Refusing to back up non-regular application state: ' + name);
    const entry = await hashStateFile(source, name);
    await copyFile(source, join(appSnapshot, name));
    await chmod(join(appSnapshot, name), 0o600).catch(() => undefined);
    files.push(entry);
  }

  const manifest: BundleManifest = {
    format: 'personal-budget-backup',
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    actualServerData: { root: actualRoot },
    personalBudgetState: { root: appStateRoot, files },
    exclusions: [
      'Secret configuration (.env), backup keys, encrypted backup archives and logs.',
      'Unmanaged ACTUAL_DATA_DIR contents belonging to @actual-app/api; only the explicitly listed Personal Budget JSON stores are included.',
      'Temporary imports, downloaded AI models, node_modules, caches and other regenerable runtime files.',
      'External Ollama models, Docker images, environment variables and credentials.',
    ],
  };
  validateBackupManifest(manifest);
  await writeFile(join(bundle, 'backup-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return bundle;
}

async function validateExtractedBundle(bundle: string): Promise<BundleManifest> {
  await assertDirectory(bundle, 'Backup bundle root is missing.');
  await assertDirectory(join(bundle, actualRoot), 'Backup is missing Actual server data.');
  await assertDirectory(join(bundle, appStateRoot), 'Backup is missing Personal Budget state directory.');
  const manifestPath = join(bundle, 'backup-manifest.json');
  const manifestInfo = await lstat(manifestPath).catch(() => null);
  if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink()) throw new Error('Backup manifest is missing or unsafe.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  validateBackupManifest(manifest);
  const typed = manifest as BundleManifest;
  const expectedFiles = new Set(typed.personalBudgetState.files.map((file) => file.name));
  const actualFiles = await readdir(join(bundle, appStateRoot));
  if (actualFiles.some((name) => !expectedFiles.has(name)) ||
      actualFiles.length !== expectedFiles.size ||
      typed.personalBudgetState.files.length !== expectedFiles.size) {
    throw new Error('Backup Personal Budget state inventory does not match its manifest.');
  }
  for (const file of typed.personalBudgetState.files) {
    const path = join(bundle, appStateRoot, file.name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.sizeBytes ||
        await checksumFile(path) !== file.sha256) {
      throw new Error('Backup Personal Budget state failed semantic integrity validation: ' + file.name);
    }
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object') throw new Error('Backup state JSON is invalid: ' + file.name);
  }
  return typed;
}

async function extractAndValidate(archive: string, key: Buffer, parent: string): Promise<ExtractedBundle> {
  const info = await stat(archive).catch(() => null);
  if (!info?.isFile()) throw new Error('Encrypted backup archive does not exist.');
  const sidecar = await readFile(archive + '.sha256', 'utf8');
  const [expected, namedFile] = sidecar.trim().split(/\s+/);
  if (!expected || namedFile !== basename(archive) || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error('Backup checksum file is invalid.');
  }
  if (await checksumFile(archive) !== expected) throw new Error('Backup checksum verification failed.');

  const stage = await mkdtemp(join(parent, '.personal-budget-restore-stage-'));
  const plaintext = join(stage, 'verified.tar.gz');
  try {
    await decryptBackupFile(archive, plaintext, key);
    await archiveMembers(plaintext);
    await command('tar', ['-xzf', plaintext, '-C', stage]);
    const bundle = join(stage, archiveRoot);
    const manifest = await validateExtractedBundle(bundle);
    return { stage, bundle, manifest };
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function verifyArchive(archive: string, key: Buffer): Promise<void> {
  const extracted = await extractAndValidate(archive, key, dirname(archive));
  await rm(extracted.stage, { recursive: true, force: true });
}

async function pruneOldBackups(): Promise<void> {
  const retentionDays = parseRetentionDays(process.env.BACKUP_RETENTION_DAYS);
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const entries = await readdir(backupDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/^personal-budget-.*\.tar\.gz\.enc$/.test(entry.name)) continue;
    const archive = join(backupDir, entry.name);
    const info = await stat(archive);
    if (info.mtimeMs < cutoff) {
      await rm(archive, { force: true });
      await rm(archive + '.sha256', { force: true });
    }
  }
}

async function backup(): Promise<string> {
  await assertApiStopped();
  await assertDirectory(dataDir, 'Actual server data directory is missing or unsafe.');
  await assertDirectory(appDataDir, 'Personal Budget application data directory is missing or unsafe.');
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const key = await loadOrCreateBackupKey(keyFile);
  const archive = join(backupDir, makeBackupFilename().replace(/\.tar\.gz$/, '.tar.gz.enc'));
  const stage = await mkdtemp(join(backupDir, '.backup-stage-'));
  const plaintext = join(stage, 'backup.tar.gz');
  let serviceStopped = false;
  try {
    await command('docker', ['compose', 'stop', 'actual']);
    serviceStopped = true;
    await buildBundle(stage);
    await command('tar', ['-czf', plaintext, '-C', stage, archiveRoot]);
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
    if (serviceStopped) {
      await command('docker', ['compose', 'up', '-d', 'actual']);
      await waitForActual();
    }
  }
  await verifyArchive(archive, key);
  await pruneOldBackups();
  return archive;
}

async function snapshotAppState(safetyDirectory: string): Promise<Set<string>> {
  await mkdir(safetyDirectory, { recursive: true, mode: 0o700 });
  const present = new Set<string>();
  for (const name of APP_STATE_FILE_NAMES) {
    const source = join(appDataDir, name);
    const info = await lstat(source).catch((error: unknown) => isMissing(error) ? null : Promise.reject(error));
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Current application state is not a regular file: ' + name);
    await copyFile(source, join(safetyDirectory, name));
    present.add(name);
  }
  return present;
}

async function installAppState(bundle: string, manifest: BundleManifest): Promise<void> {
  const sourceDirectory = join(bundle, appStateRoot);
  const targetDirectory = appDataDir;
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  const included = new Set(manifest.personalBudgetState.files.map((file) => file.name));
  for (const name of APP_STATE_FILE_NAMES) {
    const target = join(targetDirectory, name);
    if (!included.has(name)) {
      await rm(target, { force: true });
      continue;
    }
    const temporary = target + '.' + randomUUID() + '.restore.tmp';
    try {
      await copyFile(join(sourceDirectory, name), temporary);
      await chmod(temporary, 0o600).catch(() => undefined);
      await rename(temporary, target);
      await chmod(target, 0o600).catch(() => undefined);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

async function restoreAppStateFromSafety(safetyDirectory: string, previouslyPresent: ReadonlySet<string>): Promise<void> {
  await mkdir(appDataDir, { recursive: true, mode: 0o700 });
  for (const name of APP_STATE_FILE_NAMES) {
    const target = join(appDataDir, name);
    if (!previouslyPresent.has(name)) {
      await rm(target, { force: true });
      continue;
    }
    const temporary = target + '.' + randomUUID() + '.rollback.tmp';
    try {
      await copyFile(join(safetyDirectory, name), temporary);
      await chmod(temporary, 0o600).catch(() => undefined);
      await rename(temporary, target);
      await chmod(target, 0o600).catch(() => undefined);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

async function restore(archiveInput: string, confirmed: boolean): Promise<{ actualSafetyCopy?: string; appStateSafetyCopy?: string }> {
  if (!confirmed) throw new Error('Restoration replaces Actual data and app-owned state. Pass --confirm-data-restore explicitly after reviewing the backup.');
  if (!archiveInput) throw new Error('Pass an encrypted archive path: npm run restore:actual -- /path/to/personal-budget-YYYYMMDDTHHMMSSZ.tar.gz.enc --confirm-data-restore');
  const archive = resolve(root, archiveInput);
  if (!archive.endsWith('.tar.gz.enc')) throw new Error('Restore accepts encrypted .tar.gz.enc backups only.');
  await assertApiStopped();
  const key = await readBackupKey(keyFile);
  const extracted = await extractAndValidate(archive, key, dirname(dataDir));
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
  const actualSafetyCopy = dataDir + '.pre-restore-' + timestamp;
  const appStateSafetyCopy = appDataDir + '.pre-restore-' + timestamp;
  const previouslyPresent = await snapshotAppState(appStateSafetyCopy);
  const currentActualExists = await pathExists(dataDir);
  let actualStopped = false;
  let oldActualMoved = false;
  let newActualMoved = false;
  try {
    await command('docker', ['compose', 'stop', 'actual']);
    actualStopped = true;
    if (currentActualExists) {
      await rename(dataDir, actualSafetyCopy);
      oldActualMoved = true;
    }
    await rename(join(extracted.bundle, actualRoot), dataDir);
    newActualMoved = true;
    await installAppState(extracted.bundle, extracted.manifest);
    await command('docker', ['compose', 'up', '-d', 'actual']);
    actualStopped = false;
    await waitForActual();
  } catch (error) {
    let rollbackError: unknown;
    try {
      if (!actualStopped) {
        await command('docker', ['compose', 'stop', 'actual']);
        actualStopped = true;
      }
      if (newActualMoved) await rm(dataDir, { recursive: true, force: true });
      if (oldActualMoved) await rename(actualSafetyCopy, dataDir);
      await restoreAppStateFromSafety(appStateSafetyCopy, previouslyPresent);
      if (actualStopped) {
        await command('docker', ['compose', 'up', '-d', 'actual']);
        actualStopped = false;
        await waitForActual();
      }
    } catch (restoreFailure) {
      rollbackError = restoreFailure;
    }
    const reason = error instanceof Error ? error.message : 'Unknown restore failure';
    if (rollbackError) throw new Error(reason + '; rollback also failed. Preserve both safety copies and inspect Actual before retrying.');
    throw new Error(reason + '; previous Actual and application state were restored.');
  } finally {
    await rm(extracted.stage, { recursive: true, force: true }).catch(() => undefined);
    if (actualStopped) await command('docker', ['compose', 'up', '-d', 'actual']).catch(() => undefined);
  }
  return {
    ...(oldActualMoved ? { actualSafetyCopy } : {}),
    appStateSafetyCopy,
  };
}

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action === 'backup') {
    const archive = await backup();
    process.stdout.write('Verified encrypted Personal Budget backup created: ' + archive + '\n');
    return;
  }
  if (action === 'restore') {
    const result = await restore(process.argv[3] ?? '', process.argv.includes('--confirm-data-restore'));
    process.stdout.write('Restore completed from an authenticated, versioned bundle. Validate the synthetic or local account inventory before use.\n');
    if (result.actualSafetyCopy) process.stdout.write('Previous Actual data preserved at: ' + result.actualSafetyCopy + '\n');
    if (result.appStateSafetyCopy) process.stdout.write('Previous Personal Budget state preserved at: ' + result.appStateSafetyCopy + '\n');
    return;
  }
  throw new Error('Choose backup or restore.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown error';
    process.stderr.write('Personal Budget backup/restore failed: ' + message + '\n');
    process.exitCode = 1;
  });
}
