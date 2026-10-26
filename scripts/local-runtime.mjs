import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiEntry = resolve(root, 'services/api/dist/main.js');
const viteEntry = resolve(root, 'node_modules/vite/bin/vite.js');
const children = [];
let stopping = false;
let exitCode = 0;
if (!existsSync(apiEntry) || !existsSync(viteEntry)) {
  process.stderr.write('La versión compilada no está preparada. Ejecuta npm run start:local para compilar y arrancar.\n'); process.exit(1);
}
try { if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env')); }
catch { process.stderr.write('No se pudo leer .env. Revisa su formato sin compartir el contenido.\n'); process.exit(1); }
if (process.env.APP_PORT && process.env.APP_PORT !== '3000') {
  process.stderr.write('El modo diario requiere APP_PORT=3000 para coincidir con el proxy local del frontend.\n'); process.exit(1);
}
if (process.env.APP_HOST && process.env.APP_HOST !== '127.0.0.1') {
  process.stderr.write('El modo diario requiere APP_HOST=127.0.0.1 para coincidir con el proxy local del frontend.\n'); process.exit(1);
}
process.env.APP_HOST = process.env.APP_HOST || '127.0.0.1';
process.env.APP_PORT = '3000';
function start(name, args, cwd = root) {
  const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: 'inherit', windowsHide: true });
  children.push({ name, child });
  child.once('error', () => { process.stderr.write('No se pudo iniciar ' + name + '. Comprueba las dependencias y ejecuta npm ci.\n'); void shutdown(1); });
  child.once('exit', (code, signal) => {
    if (!stopping) { process.stderr.write(name + ' terminó inesperadamente (' + (signal || code) + '). Se detendrán los demás procesos.\n'); void shutdown(code === 0 ? 1 : code ?? 1); }
  });
}
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitFor(url, name, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!stopping && Date.now() < deadline) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1_000) })).ok) return; } catch { /* transient startup error */ }
    await wait(300);
  }
  throw new Error(name + ' no respondió a tiempo. Ejecuta npm run doctor para diagnosticar la instalación.');
}
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true; exitCode = code;
  // A failed spawn may emit "error" without ever receiving a PID or an "exit" event.
  const live = children.filter(({ child }) => child.pid !== undefined && child.exitCode === null && child.signalCode === null);
  if (live.length) {
    // Subscribe before sending signals so fast exits cannot be missed between kill() and listener registration.
    const closed = live.map(({ child }) => new Promise((done) => {
      if (child.exitCode !== null || child.signalCode !== null) return done();
      child.once('close', done);
    }));
    const forceTimer = setTimeout(() => {
      for (const { child } of live) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }, 5_000);
    forceTimer.unref();
    for (const { child } of live) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    await Promise.all(closed);
    clearTimeout(forceTimer);
  }
  process.exitCode = exitCode;
}
process.once('SIGINT', () => { void shutdown(0); });
process.once('SIGTERM', () => { void shutdown(0); });
start('API local', [apiEntry]);
start('Frontend compilado', [viteEntry, 'preview', '--host', '127.0.0.1', '--port', '4173', '--strictPort'], resolve(root, 'apps/web'));
try {
  await waitFor('http://127.0.0.1:3000/health', 'La API local');
  await waitFor('http://127.0.0.1:4173/', 'El frontend compilado');
  if (!stopping) {
    console.log('personal-budget listo en http://127.0.0.1:4173');
    console.log('API local: http://127.0.0.1:3000 · Ctrl+C detiene ambos procesos.');
    console.log('El estado de Actual y del asistente se muestra por separado en la interfaz.');
  }
} catch (error) {
  if (!stopping) {
    process.stderr.write((error instanceof Error ? error.message : 'No se pudo iniciar la aplicación local.') + '\n');
    await shutdown(1);
  }
}
