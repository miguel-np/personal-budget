import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../services/api/src/config.js';
import { parseDotEnv, safeConfigFailure, supportsNodeVersion, supportsNpmVersion } from './runtime-checks.js';
type Severity = 'OK' | 'AVISO' | 'ERROR';
interface Check { name: string; severity: Severity; detail: string; }
const root = process.cwd();
const envFile = resolve(root, '.env');
const fileValues = existsSync(envFile) ? parseDotEnv(readFileSync(envFile, 'utf8')) : {};
const effective: NodeJS.ProcessEnv = { ...fileValues, ...process.env };
const checks: Check[] = [];
const add = (name: string, severity: Severity, detail: string) => checks.push({ name, severity, detail });
const nodeVersion = process.versions.node;
add('Node.js', supportsNodeVersion(nodeVersion) ? 'OK' : 'ERROR', supportsNodeVersion(nodeVersion) ? 'versión compatible con la baseline 24.22.1' : 'se requiere Node.js 24.22.1 o superior de la serie 24.x');
const npmResult = spawnSync('npm', ['--version'], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
const npmVersion = npmResult.status === 0 ? npmResult.stdout.trim() : '';
add('npm', npmVersion && supportsNpmVersion(npmVersion) ? 'OK' : 'ERROR', npmVersion && supportsNpmVersion(npmVersion) ? 'versión compatible' : 'se requiere npm 11.6.0 o superior');
add('.env', existsSync(envFile) ? 'OK' : 'AVISO', existsSync(envFile) ? 'archivo presente; los valores no se muestran' : 'falta .env; copia .env.example y configura el presupuesto local');
let config: ReturnType<typeof loadConfig> | undefined;
try {
  config = loadConfig(effective);
  add('Configuración', 'OK', 'las variables reconocidas pasan la validación; no se imprimen valores');
} catch (error) { add('Configuración', 'ERROR', safeConfigFailure(error)); }
if (!effective.ACTUAL_BUDGET_ID?.trim()) add('Presupuesto', 'AVISO', 'ACTUAL_BUDGET_ID no está configurado; el valor nunca se muestra');
const docker = spawnSync('docker', ['compose', 'ps', '--services', '--status', 'running'], { cwd: root, encoding: 'utf8', timeout: 5_000, windowsHide: true });
if (docker.error || docker.status !== 0) add('Docker Compose', 'AVISO', 'no se pudo consultar Docker; inicia Docker Desktop y activa la integración WSL2');
else if (docker.stdout.split(/\r?\n/).includes('actual')) add('Docker Compose', 'OK', 'Actual figura como iniciado en Docker Compose');
else add('Docker Compose', 'AVISO', 'Actual no figura iniciado; ejecuta docker compose up -d actual');
async function probe(url: string, timeoutMs = 1_500): Promise<number | null> {
  try { return (await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })).status; } catch { return null; }
}
const main = async () => {
  if (config) {
    if (config.port !== 3000) add('APP_PORT', 'ERROR', 'el modo diario requiere el puerto 3000 para coincidir con el proxy local del frontend');
    const actualStatus = await probe(config.actualServerURL);
    add('Servidor Actual', actualStatus !== null && actualStatus < 500 ? 'OK' : 'AVISO', actualStatus !== null && actualStatus < 500 ? 'responde en su dirección local' : 'no responde; revisa Docker, puerto local y docker compose logs actual');
    const apiStatus = await probe('http://127.0.0.1:' + config.port + '/health');
    add('API local', apiStatus === 200 ? 'OK' : 'AVISO', apiStatus === 200 ? 'health responde' : 'API apagada; npm run start:local la inicia junto con el frontend');
    const webStatus = await probe('http://127.0.0.1:4173/');
    add('Frontend compilado', webStatus === 200 ? 'OK' : 'AVISO', webStatus === 200 ? 'frontend local disponible' : 'frontend apagado; npm run start:local compila y lo inicia');
    if (config.aiEnabled) {
      const ai = await probe(new URL('/api/tags', config.ollamaBaseURL).toString(), 2_000);
      add('Ollama', ai !== null && ai < 500 ? 'OK' : 'AVISO', ai !== null && ai < 500 ? 'endpoint local responde' : 'asistente opcional no disponible; las finanzas básicas no dependen de él');
    } else add('Ollama', 'OK', 'asistente desactivado; no afecta a las operaciones financieras básicas');
  }
  for (const check of checks) console.log('[' + check.severity + '] ' + check.name + ': ' + check.detail);
  const errors = checks.filter((check) => check.severity === 'ERROR');
  console.log('\nDiagnóstico: ' + errors.length + ' error(es), ' + checks.filter((check) => check.severity === 'AVISO').length + ' aviso(s).');
  if (errors.length) process.exitCode = 1;
};
void main();
