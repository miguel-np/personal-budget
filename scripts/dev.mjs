import { startDevProcesses } from './dev-supervisor.mjs';

const npmExecPath = process.env.npm_execpath;

if (!npmExecPath) {
  process.stderr.write('Ejecuta este comando con «npm run dev» desde la raíz del repositorio.\n');
  process.exitCode = 1;
} else {
  process.stdout.write('Iniciando API y frontend en modo desarrollo. Pulsa Ctrl+C para detener ambos.\n');
  const supervisor = startDevProcesses({
    scripts: ['dev:api', 'dev:web'],
    npmExecPath
  });

  process.once('SIGINT', () => {
    process.exitCode = 130;
    supervisor.stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    process.exitCode = 143;
    supervisor.stop('SIGTERM');
  });
}
