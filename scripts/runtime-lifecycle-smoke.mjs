import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = spawn(process.execPath, ['scripts/local-runtime.mjs'], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
});
let runtimeExit;
runtime.once('exit', (code, signal) => {
  runtimeExit = { code, signal };
});

async function request(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return { ok: response.ok, response };
  } catch {
    return { ok: false, response: null };
  }
}

async function waitUntil(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (runtimeExit) throw new Error(`Runtime terminó antes de completar la comprobación (${runtimeExit.signal ?? runtimeExit.code}).`);
    await delay(250);
  }
  throw new Error(message);
}

async function stopRuntime() {
  if (runtime.exitCode !== null) return;
  runtime.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => runtime.once('exit', resolveExit)),
    delay(8_000).then(() => { throw new Error('El proceso principal no terminó en 8 segundos tras SIGTERM.'); }),
  ]);
}

try {
  await waitUntil(async () => {
    const ui = await request('http://127.0.0.1:4173/');
    const health = await request('http://127.0.0.1:3000/health');
    return ui.ok && health.ok;
  }, 40_000, 'La UI compilada y la API no quedaron disponibles dentro del tiempo límite.');

  const readiness = await request('http://127.0.0.1:3000/ready');
  if (!readiness.ok) throw new Error('El endpoint de readiness no respondió correctamente.');
  const readinessBody = await readiness.response.json();
  if (readinessBody.status !== 'not_configured') {
    throw new Error('El entorno sintético debía indicar status=not_configured; se recibió otro estado.');
  }

  await stopRuntime();
  await waitUntil(async () => {
    const ui = await request('http://127.0.0.1:4173/');
    const api = await request('http://127.0.0.1:3000/health');
    return !ui.ok && !api.ok;
  }, 5_000, 'Tras detener el runtime, la UI o la API sigue respondiendo; posible proceso huérfano.');

  if (runtimeExit?.code !== 0 && runtimeExit?.signal !== 'SIGTERM') {
    throw new Error(`El runtime terminó con un resultado inesperado: ${JSON.stringify(runtimeExit)}.`);
  }
  console.log('Runtime lifecycle OK: producción disponible, readiness explícito, SIGTERM limpio y puertos liberados.');
} catch (error) {
  if (runtime.exitCode === null) {
    runtime.kill('SIGKILL');
    await Promise.race([new Promise((resolveExit) => runtime.once('exit', resolveExit)), delay(2_000)]);
  }
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
}
