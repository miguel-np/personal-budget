import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appDataDir = resolve(root, process.env.ACTUAL_DATA_DIR ?? './.local/actual-api');
const actualDataDir = resolve(root, process.env.ACTUAL_SERVER_DATA_DIR ?? './.local/actual-server-data');
const backupDir = resolve(root, process.env.BACKUP_DIR ?? './.local/backups');
const keyFile = resolve(root, process.env.BACKUP_ENCRYPTION_KEY_FILE ?? './.local/backup-key.bin');
const files = [
  'account-scope-preferences.json',
  'app-preferences.json',
  'currency-preferences.json',
  'financial-intelligence-state.json',
  'periodic-reviews.json',
  'planning-data.json',
] as const;

const fixture = {
  'account-scope-preferences.json': {
    mode: 'selected',
    accountIds: ['synthetic-account-001'],
  },
  'app-preferences.json': {
    theme: 'dark',
    locale: 'es-ES',
  },
  'currency-preferences.json': {
    displayCurrency: 'EUR',
    accountCurrencyOverrides: {},
    exchangeRates: [],
  },
  'financial-intelligence-state.json': {
    version: 1,
    reviews: [{
      findingId: 'synthetic-finding-001',
      fingerprint: '0123456789abcdef',
      status: 'reviewed',
      updatedAt: '2026-11-01T00:00:00.000Z',
    }],
  },
  'periodic-reviews.json': {
    version: 1,
    reviews: [{
      id: '00000000-0000-4000-8000-000000000002',
      periodType: 'monthly',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      generatedAt: '2026-11-01T00:00:00.000Z',
      currency: 'EUR',
      accountScope: {
        mode: 'all',
        label: 'Todas las cuentas sintéticas',
        fingerprint: '0123456789abcdef',
      },
      status: 'completed',
      completedAt: '2026-11-01T00:00:00.000Z',
      items: [],
    }],
  },
  'planning-data.json': {
    version: 1,
    goals: [{
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Fondo de emergencia sintético',
      targetAmountMinor: 500_000,
      initialAmountMinor: 10_000,
      monthlyContributionMinor: 25_000,
      targetDate: '2027-12-31',
      monthlyIncomeMinor: null,
      monthlyExpenseMinor: null,
      currency: 'EUR',
      scope: { mode: 'all', accountIds: [] },
      status: 'active',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    }],
    commitments: [],
  },
} as const;

function run(program: string, args: readonly string[]): void {
  execFileSync(program, [...args], { cwd: root, env: process.env, stdio: 'inherit' });
}
function expectFailure(program: string, args: readonly string[]): void {
  const result = spawnSync(program, [...args], { cwd: root, env: process.env, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status === 0) throw new Error('Expected the restore command to fail closed, but it succeeded.');
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  if (!/authentication failed|key may be wrong|altered/i.test(output)) {
    throw new Error('Restore failed for an unexpected reason during the wrong-key acceptance check.');
  }
}

async function seed(): Promise<void> {
  await mkdir(appDataDir, { recursive: true, mode: 0o700 });
  for (const name of files) {
    await writeFile(join(appDataDir, name), JSON.stringify(fixture[name], null, 2) + '\n', { mode: 0o600 });
    await chmod(join(appDataDir, name), 0o600).catch(() => undefined);
  }
  process.stdout.write('Seeded six synthetic Personal Budget state files.\n');
}

async function verifyAppState(): Promise<void> {
  for (const name of files) {
    const content = await readFile(join(appDataDir, name), 'utf8');
    const expected = JSON.stringify(fixture[name], null, 2) + '\n';
    if (content !== expected) throw new Error('Restored Personal Budget state differs from the synthetic fixture: ' + name);
  }
  process.stdout.write('Verified six restored Personal Budget state files.\n');
}

async function roundtrip(): Promise<void> {
  await verifyAppState();
  const keyBefore = await readFile(keyFile);
  run('npm', ['run', 'backup:actual']);

  const archives = (await readdir(backupDir))
    .filter((name) => /^personal-budget-.*\.tar\.gz\.enc$/.test(name))
    .sort();
  const archiveName = archives.at(-1);
  if (!archiveName) throw new Error('The unified backup command did not create an encrypted archive.');
  const archive = join(backupDir, archiveName);
  const relativeArchive = relative(root, archive);

  // A wrong key must fail during authenticated decryption, before Actual or app state is touched.
  try {
    await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
    await chmod(keyFile, 0o600).catch(() => undefined);
    expectFailure('npm', ['run', 'restore:actual', '--', relativeArchive, '--confirm-data-restore']);
  } finally {
    await writeFile(keyFile, keyBefore, { mode: 0o600 });
    await chmod(keyFile, 0o600).catch(() => undefined);
  }
  await verifyAppState();

  // Simulate loss of both data sets in this disposable CI runner.
  run('docker', ['compose', 'stop', 'actual']);
  await rm(actualDataDir, { recursive: true, force: true });
  await mkdir(actualDataDir, { recursive: true, mode: 0o700 });
  for (const name of files) await rm(join(appDataDir, name), { force: true });

  run('npm', ['run', 'restore:actual', '--', relativeArchive, '--confirm-data-restore']);
  await verifyAppState();
  run('npm', ['run', 'test:update:acceptance', '--', 'verify']);
  process.stdout.write('Unified encrypted restore preserved the synthetic Actual inventory and all app-owned state.\n');
}

const action = process.argv[2];
if (action === 'seed') await seed();
else if (action === 'verify') await verifyAppState();
else if (action === 'roundtrip') await roundtrip();
else throw new Error('Choose seed, verify or roundtrip.');
