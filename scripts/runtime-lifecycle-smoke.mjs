import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = await mkdtemp(join(tmpdir(), 'personal-budget-runtime-lifecycle-'));
const sentinelPath = join(dataDir, 'persistence-sentinel.json');
await writeFile(sentinelPath, JSON.stringify({ marker: 'runtime-lifecycle', revision: 1 }), 'utf8');
await writeFile(join(dataDir, 'currency-preferences.json'), JSON.stringify({ displayCurrency: 'GBP', accountCurrencyOverrides: {}, exchangeRates: [] }), 'utf8');
const initialDataSnapshot = await snapshotDirectory(dataDir);
let runtime;
let runtimeExit;
let runtimeSpawnError;
let runtimeReady = false;
let runtimeOutput = '';

function startRuntime() {
  runtimeExit = undefined;
  runtimeSpawnError = undefined;
  runtimeReady = false;
  runtimeOutput = '';
  runtime = spawn(process.execPath, ['scripts/local-runtime.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      APP_HOST: '127.0.0.1',
      APP_PORT: '3000',
      ACTUAL_BUDGET_ID: '',
      ACTUAL_SERVER_PASSWORD: '',
      ACTUAL_SERVER_URL: 'http://127.0.0.1:9',
      ACTUAL_DATA_DIR: dataDir,
      AI_ENABLED: 'false',
      MCP_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  runtime.stdout.on('data', (chunk) => {
    const output = chunk.toString();
    process.stdout.write(output);
    runtimeOutput = (runtimeOutput + output).slice(-10_000);
    if (runtimeOutput.includes('personal-budget listo en http://127.0.0.1:4173')) runtimeReady = true;
  });
  runtime.stderr.on('data', (chunk) => {
    const output = chunk.toString();
    process.stderr.write(output);
    runtimeOutput = (runtimeOutput + output).slice(-10_000);
  });
  runtime.once('error', (error) => { runtimeSpawnError = error; });
  runtime.once('exit', (code, signal) => { runtimeExit = { code, signal }; });
}

async function request(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return { ok: response.ok, status: response.status, response };
  } catch {
    return { ok: false, status: null, response: null };
  }
}

async function waitUntil(check, timeoutMs, message, requireRunningRuntime = true) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (runtimeSpawnError) throw new Error('No se pudo crear el proceso runtime: ' + runtimeSpawnError.message);
    if (requireRunningRuntime && runtimeExit) {
      throw new Error(`Runtime terminó antes de completar la comprobación (${runtimeExit.signal ?? runtimeExit.code}).`);
    }
    await delay(250);
  }
  throw new Error(message);
}

async function waitForRuntimeExit(timeoutMs) {
  if (runtimeExit) return;
  if (runtimeSpawnError) throw runtimeSpawnError;
  await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      runtime.off('exit', onExit);
      runtime.off('error', onError);
      reject(new Error(`El proceso principal no terminó en ${timeoutMs / 1_000} segundos.`));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      runtime.off('error', onError);
      resolveExit();
    };
    const onError = (error) => {
      clearTimeout(timer);
      runtime.off('exit', onExit);
      reject(error);
    };
    runtime.once('exit', onExit);
    runtime.once('error', onError);
  });
}

async function stopRuntime(signal = 'SIGTERM') {
  if (!runtime || runtimeExit || runtimeSpawnError) return;
  runtime.kill(signal);
  try {
    await waitForRuntimeExit(8_000);
  } catch (error) {
    if (!runtimeExit && !runtimeSpawnError) {
      runtime.kill('SIGKILL');
      try { await waitForRuntimeExit(2_000); } catch { /* Failure remains a test failure. */ }
      if (!runtimeExit && process.platform !== 'win32' && runtime.pid) {
        try { process.kill(-runtime.pid, 'SIGKILL'); } catch { /* The process group may already have exited. */ }
      }
    }
    throw error;
  }
}

async function assertRunningAndReady() {
  await waitUntil(async () => {
    const ui = await request('http://127.0.0.1:4173/');
    const health = await request('http://127.0.0.1:3000/health');
    return runtimeReady && ui.ok && health.ok;
  }, 40_000, 'La UI compilada y la API no quedaron disponibles dentro del tiempo límite.');

  const readiness = await request('http://127.0.0.1:4173/ready');
  if (!readiness.response) throw new Error('El endpoint de readiness no respondió.');
  const readinessBody = await readiness.response.json();
  if (readiness.status !== 503 || readinessBody.status !== 'not_configured') {
    throw new Error(`Se esperaba HTTP 503 y status=not_configured; se recibió HTTP ${readiness.status} y status=${String(readinessBody.status)}.`);
  }

  const preferences = await request('http://127.0.0.1:4173/api/v1/preferences/currency');
  if (!preferences.ok || !preferences.response) throw new Error('No se pudieron leer las preferencias persistidas de prueba.');
  const preferencesBody = await preferences.response.json();
  if (preferencesBody.data?.displayCurrency !== 'GBP') {
    throw new Error('La API no leyó el valor sintético guardado en el directorio de datos aislado.');
  }
}

async function assertStoppedAndReleased() {
  await waitForRuntimeExit(8_000);
  if (runtimeExit?.code !== 0 || runtimeExit?.signal !== null) {
    throw new Error(`El runtime no terminó mediante el manejador de apagado limpio: ${JSON.stringify(runtimeExit)}.`);
  }
  await waitUntil(async () => {
    const ui = await request('http://127.0.0.1:4173/');
    const api = await request('http://127.0.0.1:3000/health');
    return ui.response === null && api.response === null;
  }, 5_000, 'Tras detener el runtime, la UI o la API sigue respondiendo; posible proceso huérfano.', false);
  const snapshot = await snapshotDirectory(dataDir);
  if (snapshot !== initialDataSnapshot) {
    throw new Error('El directorio de datos sintéticos cambió durante el arranque/parada; posible alteración de datos persistentes.');
  }
}

async function snapshotDirectory(directory) {
  const entries = await readdir(directory);
  const snapshot = {};
  for (const name of entries.sort()) {
    const path = join(directory, name);
    const metadata = await stat(path);
    snapshot[name] = metadata.isDirectory()
      ? { type: 'directory', entries: JSON.parse(await snapshotDirectory(path)) }
      : { type: 'file', content: (await readFile(path)).toString('base64') };
  }
  return JSON.stringify(snapshot);
}

try {
  for (let iteration = 1; iteration <= 2; iteration += 1) {
    startRuntime();
    await assertRunningAndReady();
    await stopRuntime(iteration === 1 ? 'SIGINT' : 'SIGTERM');
    await assertStoppedAndReleased();
    console.log(`Runtime lifecycle iteration ${iteration}/2 passed.`);
  }
  console.log('Runtime lifecycle OK: SIGINT/SIGTERM, readiness, port release, restart and isolated preference snapshot verified.');
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
} finally {
  if (runtime && !runtimeExit && !runtimeSpawnError) {
    try { await stopRuntime(); } catch { /* Preserve the failure and prevent the test from hanging. */ }
  }
  if (runtime && !runtimeExit && process.platform !== 'win32' && runtime.pid) {
    try { process.kill(-runtime.pid, 'SIGKILL'); } catch { /* The process group may already have exited. */ }
  }
  await rm(dataDir, { recursive: true, force: true });
}
