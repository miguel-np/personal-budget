import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { decryptBackupFile, readBackupKey } from './backup-encryption.js';
import { validateArchiveEntryTypes, validateArchiveMembers } from './backup-restore.js';
import { assertSupportedTransition, parseActualImage } from './update-policy.js';
import type { TestedTransition } from './update-policy.js';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const statePath = resolve(root, '.local/update-state.json');
const dataDir = resolve(root, process.env.ACTUAL_SERVER_DATA_DIR ?? '.local/actual-server-data');
const keyFile = resolve(root, process.env.BACKUP_ENCRYPTION_KEY_FILE ?? '.local/backup-key.bin');
const compatibilityPath = join(root, 'docs/update-compatibility.json');
const MIN_FREE_BYTES = 256 * 1024 * 1024;
const READY_TIMEOUT_MS = 90_000;
const TEST_FAILURE_ENV = 'PERSONAL_BUDGET_TEST_FAIL_AFTER_SWITCH';

interface UpdateState {
  readonly status: 'updated' | 'pre-switch-failed' | 'recovery-required' | 'restore-in-progress' | 'restored';
  readonly previousImage: string;
  readonly targetImage: string;
  readonly backupArchive: string;
  readonly stage: string;
  readonly updatedAt: string;
  readonly detail?: string;
}

interface ComposeDocument {
  readonly services?: Readonly<Record<string, { readonly image?: string }>>;
}

function now(): string { return new Date().toISOString(); }

async function command(program: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(program, args, { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, env });
}

/** Invoke npm's JavaScript CLI via Node to avoid shell execution of npm.cmd on Windows. */
async function npmCommand(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run this operation through npm run so its installed npm CLI can be resolved.');
  return command(process.execPath, [npmCli, ...args]);
}

async function composeImage(): Promise<string> {
  const result = await command('docker', ['compose', 'config', '--format', 'json']);
  const document = JSON.parse(result.stdout) as ComposeDocument;
  const image = document.services?.actual?.image;
  if (!image) throw new Error('Compose does not declare an Actual Budget image.');
  return parseActualImage(image).image;
}

async function runningImage(): Promise<string> {
  const result = await command('docker', ['inspect', 'personal-budget-actual', '--format', '{{.Config.Image}}']);
  return parseActualImage(result.stdout.trim()).image;
}

async function imageTransitions(): Promise<readonly TestedTransition[]> {
  const parsed = JSON.parse(await readFile(compatibilityPath, 'utf8')) as { testedTransitions?: readonly TestedTransition[] };
  if (!Array.isArray(parsed.testedTransitions)) throw new Error('The Actual update compatibility matrix is invalid.');
  return parsed.testedTransitions;
}

async function directoryBytes(path: string): Promise<number> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return 0;
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;
  const children = await readdir(path);
  let total = 0;
  for (const child of children) total += await directoryBytes(join(path, child));
  return total;
}

async function assertDiskSpace(): Promise<void> {
  const [directory, filesystem] = await Promise.all([directoryBytes(dataDir), statfs(dirname(dataDir))]);
  const freeBytes = filesystem.bavail * filesystem.bsize;
  const requiredBytes = Math.max(MIN_FREE_BYTES, directory * 2);
  if (freeBytes < requiredBytes) {
    throw new Error('Insufficient free disk space for a safe update. Required at least ' +
      Math.ceil(requiredBytes / (1024 * 1024)) + ' MiB free before starting.');
  }
}

async function waitForReady(timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:5006/', { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return;
      lastStatus = 'HTTP ' + response.status;
    } catch { lastStatus = 'local service unreachable'; }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  }
  throw new Error('Actual Budget did not become ready within ' + Math.round(timeoutMs / 1000) +
    ' seconds (' + lastStatus + ').');
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + '.' + process.pid + '.tmp';
  try {
    await writeFile(temp, contents, { flag: 'wx', mode: 0o600 });
    await chmod(temp, 0o600).catch(() => undefined);
    await rename(temp, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

async function saveState(state: UpdateState): Promise<void> {
  await writeAtomic(statePath, JSON.stringify(state, null, 2) + '\n');
}

async function readState(): Promise<UpdateState> {
  return JSON.parse(await readFile(statePath, 'utf8')) as UpdateState;
}

async function readEnvContents(): Promise<string | null> {
  try { return await readFile(envPath, 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function setImageInEnv(image: string): Promise<void> {
  const current = await readEnvContents();
  const lines = (current ?? '').split(/\r?\n/);
  const filtered = lines.filter((line) => !/^\s*ACTUAL_IMAGE\s*=/.test(line));
  while (filtered.length > 0 && filtered[filtered.length - 1] === '') filtered.pop();
  filtered.push('ACTUAL_IMAGE=' + image);
  await writeAtomic(envPath, filtered.join('\n') + '\n');
}

async function restoreEnvContents(contents: string | null): Promise<void> {
  if (contents === null) {
    await rm(envPath, { force: true });
    return;
  }
  await writeAtomic(envPath, contents);
}

async function archiveMembers(archive: string): Promise<void> {
  const listing = await command('tar', ['-tzf', archive]);
  const detailedListing = await command('tar', ['-tvzf', archive]);
  validateArchiveMembers(listing.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean), basename(dataDir));
  validateArchiveEntryTypes(detailedListing.stdout.split(/\r?\n/).filter(Boolean));
}

async function verifyEncryptedArchive(archiveInput: string): Promise<void> {
  const archive = resolve(root, archiveInput);
  const info = await stat(archive).catch(() => null);
  if (!info?.isFile() || !archive.endsWith('.tar.gz.enc')) throw new Error('The expected encrypted backup archive is missing or invalid.');
  const sidecar = await readFile(archive + '.sha256', 'utf8');
  const [expected, namedFile] = sidecar.trim().split(/\s+/);
  if (!expected || namedFile !== basename(archive) || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error('The backup checksum metadata is invalid.');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest('hex') !== expected) throw new Error('The encrypted backup checksum does not match.');

  const key = await readBackupKey(keyFile);
  const verifyDirectory = await mkdtemp(join(dirname(archive), '.update-verify-'));
  const plaintext = join(verifyDirectory, 'verified.tar.gz');
  try {
    await decryptBackupFile(archive, plaintext, key);
    await archiveMembers(plaintext);
  } finally {
    await rm(verifyDirectory, { recursive: true, force: true });
  }
}

async function createVerifiedBackup(): Promise<string> {
  const result = await npmCommand(['run', 'backup:actual']);
  const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith('Verified encrypted backup created: '));
  if (!line) throw new Error('The backup command did not report a verified archive path.');
  const archive = line.slice('Verified encrypted backup created: '.length).trim();
  await verifyEncryptedArchive(archive);
  return resolve(root, archive);
}

export async function preflight(targetImage: string): Promise<{ readonly currentImage: string; readonly targetImage: string }> {
  if (process.env.ACTUAL_IMAGE) {
    throw new Error('ACTUAL_IMAGE is exported in the current shell. Unset it and configure the pinned image in the local .env file instead.');
  }
  const [currentImage, running, transitions] = await Promise.all([composeImage(), runningImage(), imageTransitions()]);
  if (currentImage !== running) {
    throw new Error('The running Actual image differs from the Compose configuration. Reconcile the current installation before updating.');
  }
  assertSupportedTransition(currentImage, targetImage, transitions);
  await stat(dataDir);
  await assertDiskSpace();
  await waitForReady(10_000);
  return { currentImage, targetImage: parseActualImage(targetImage).image };
}

async function update(targetInput: string): Promise<void> {
  if (process.env.ACTUAL_IMAGE) {
    throw new Error('ACTUAL_IMAGE is exported in the current shell. Unset it and configure the pinned image in .env.');
  }
  if (process.env[TEST_FAILURE_ENV] && process.env.NODE_ENV !== 'test') {
    throw new Error('The update-failure injection is only available in NODE_ENV=test.');
  }
  const targetImage = parseActualImage(targetInput).image;
  const { currentImage } = await preflight(targetImage);
  const oldEnvContents = await readEnvContents();
  const policy = await imageTransitions();
  assertSupportedTransition(currentImage, targetImage, policy);

  process.stdout.write('Preflight passed for ' + currentImage + ' -> ' + targetImage + '. Creating and verifying an encrypted backup.\n');
  const archive = await createVerifiedBackup();
  let switchAttempted = false;
  let stage = 'backup-verified';
  await saveState({
    status: 'pre-switch-failed', previousImage: currentImage, targetImage, backupArchive: archive,
    stage, updatedAt: now(), detail: 'Encrypted backup verified; update has not switched images yet.',
  });

  try {
    await setImageInEnv(targetImage);
    stage = 'target-configured';
    await saveState({
      status: 'pre-switch-failed', previousImage: currentImage, targetImage, backupArchive: archive,
      stage, updatedAt: now(),
    });

    await command('docker', ['compose', 'pull', 'actual']);
    stage = 'image-pulled';
    await saveState({
      status: 'pre-switch-failed', previousImage: currentImage, targetImage, backupArchive: archive,
      stage, updatedAt: now(),
    });

    switchAttempted = true;
    stage = 'switch-attempted';
    await saveState({
      status: 'recovery-required', previousImage: currentImage, targetImage, backupArchive: archive,
      stage, updatedAt: now(), detail: 'The new container may now modify the Actual data directory.',
    });
    await command('docker', ['compose', 'up', '-d', 'actual']);
    stage = 'target-started';
    await saveState({
      status: 'recovery-required', previousImage: currentImage, targetImage, backupArchive: archive,
      stage, updatedAt: now(), detail: 'Target container started; readiness and data access still need verification.',
    });

    if (process.env[TEST_FAILURE_ENV] === '1') {
      throw new Error('Injected update failure for the isolated synthetic acceptance test.');
    }
    await waitForReady();
    const activeImage = await runningImage();
    if (activeImage !== targetImage) throw new Error('Docker is not running the requested target image after readiness.');
    await saveState({
      status: 'updated', previousImage: currentImage, targetImage, backupArchive: archive,
      stage: 'verified', updatedAt: now(), detail: 'Target image answered readiness; a semantic inventory check is still recommended.',
    });
    process.stdout.write('Update completed. Image: ' + targetImage + '. Encrypted recovery archive: ' + archive + '\n');
    process.stdout.write('Verify account, category, transaction and balance inventory before normal use. The backup is retained until its retention period expires.\n');
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown update failure';
    if (!switchAttempted) {
      await restoreEnvContents(oldEnvContents);
      await command('docker', ['compose', 'up', '-d', 'actual']).catch(() => undefined);
      await waitForReady(20_000).catch(() => undefined);
      await saveState({
        status: 'pre-switch-failed', previousImage: currentImage, targetImage, backupArchive: archive,
        stage, updatedAt: now(), detail,
      });
      throw new Error('Update failed before the new container was started. The previous image configuration was restored; the encrypted backup is retained at ' + archive + '. Cause: ' + detail);
    }

    await command('docker', ['compose', 'stop', 'actual']).catch(() => undefined);
    await saveState({
      status: 'recovery-required', previousImage: currentImage, targetImage, backupArchive: archive,
      stage, updatedAt: now(), detail,
    });
    throw new Error(
      'The target image did not pass verification after its container switch. Actual has been stopped; no old image was restarted and no data was overwritten automatically because the target may have migrated the data. The verified encrypted backup is retained at ' +
      archive + '. Explicit recovery command: npm run update:actual -- restore-backup --backup ' +
      archive + ' --to-image ' + currentImage + ' --confirm-data-restore. Cause: ' + detail,
    );
  }
}

async function restoreBackup(archiveInput: string, imageInput: string, confirmed: boolean): Promise<void> {
  if (!confirmed) throw new Error('Data restoration overwrites the current Actual directory. Pass --confirm-data-restore explicitly to acknowledge this.');
  if (process.env.ACTUAL_IMAGE) throw new Error('ACTUAL_IMAGE is exported in the current shell. Unset it before recovery.');
  const archive = resolve(root, archiveInput);
  const targetImage = parseActualImage(imageInput).image;
  const state = await readState();
  const configuredImage = await composeImage();
  // A failed restore leaves the source image configured and the state marked restore-in-progress.
  // Permit a conscious retry only when the same backup and recorded source image still match.
  const retryingRestore = state.status === 'restore-in-progress';
  const expectedConfiguredImage = retryingRestore ? targetImage : state.targetImage;
  if (resolve(state.backupArchive) !== archive || state.previousImage !== targetImage || expectedConfiguredImage !== configuredImage) {
    throw new Error('Recovery parameters do not match the recorded update and backup. No data was restored.');
  }
  if (!['updated', 'recovery-required', 'restore-in-progress'].includes(state.status)) {
    throw new Error('There is no completed, failed, or resumable update awaiting explicit data restoration.');
  }
  await verifyEncryptedArchive(archive);
  await setImageInEnv(targetImage);
  await saveState({
    ...state, status: 'restore-in-progress', stage: 'explicit-data-restore', updatedAt: now(),
    detail: 'User explicitly confirmed restoration of the encrypted pre-update data archive.',
  });
  await npmCommand(['run', 'restore:actual', '--', archive, '--confirm-data-restore']);
  await waitForReady();
  if (await runningImage() !== targetImage) throw new Error('Data restore finished, but the running image does not match the selected rollback image.');
  await saveState({
    ...state, status: 'restored', stage: 'verified', updatedAt: now(),
    detail: 'The explicitly confirmed encrypted backup was restored and the previous image passed readiness.',
  });
  process.stdout.write('Explicit data recovery completed using ' + targetImage + '. The restore script preserved the replaced directory as a safety copy; validate the financial inventory before normal use.\n');
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const [action, ...args] = process.argv.slice(2);
  const target = option(args, '--to');
  if (action === 'preflight') {
    if (!target) throw new Error('Usage: npm run update:actual -- preflight --to actualbudget/actual-server:X.Y.Z');
    const result = await preflight(target);
    process.stdout.write('Preflight passed: ' + result.currentImage + ' -> ' + result.targetImage + '. No update was applied.\n');
    return;
  }
  if (action === 'update') {
    if (!target || !args.includes('--confirm')) throw new Error('Usage: npm run update:actual -- update --to actualbudget/actual-server:X.Y.Z --confirm');
    await update(target);
    return;
  }
  if (action === 'restore-backup') {
    const archive = option(args, '--backup');
    const image = option(args, '--to-image');
    if (!archive || !image) throw new Error('Usage: npm run update:actual -- restore-backup --backup /path/to/backup.tar.gz.enc --to-image actualbudget/actual-server:X.Y.Z --confirm-data-restore');
    await restoreBackup(archive, image, args.includes('--confirm-data-restore'));
    return;
  }
  throw new Error('Choose preflight, update, or restore-backup.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown update failure';
    process.stderr.write('Actual safe-update failed: ' + message + '\n');
    process.exitCode = 1;
  });
}
