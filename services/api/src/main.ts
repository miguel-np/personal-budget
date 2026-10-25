import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ActualApiNamespace from '@actual-app/api';
import { ActualBudgetAdapter } from '@personal-budget/actual-adapter';
import type { ActualApiContract } from '@personal-budget/actual-adapter';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(moduleDirectory, '../../..');

function loadLocalEnvironment(): void {
  const candidates = [resolve(process.cwd(), '.env'), resolve(repositoryRoot, '.env')];
  const environmentFile = candidates.find((candidate) => existsSync(candidate));
  if (environmentFile) process.loadEnvFile(environmentFile);
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  const parsedConfig = loadConfig();
  const config = {
    ...parsedConfig,
    actualDataDir: isAbsolute(parsedConfig.actualDataDir) ? parsedConfig.actualDataDir : resolve(repositoryRoot, parsedConfig.actualDataDir),
  };
  const api = ActualApiNamespace as unknown as ActualApiContract;
  const repository = new ActualBudgetAdapter({
    serverURL: config.actualServerURL,
    dataDir: config.actualDataDir,
    ...(config.actualBudgetId ? { budgetId: config.actualBudgetId } : {}),
    ...(config.actualServerPassword ? { password: config.actualServerPassword } : {}),
  }, api);
  const app = await buildApp({ repository, config });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'Stopping local API.');
    try {
      await app.close();
      await repository.close();
      process.exitCode = 0;
    } catch {
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

  await app.listen({ host: config.host, port: config.port });
  app.log.info({ host: config.host, port: config.port }, 'Local API is listening.');
}

main().catch(() => {
  process.stderr.write('personal-budget API failed to start; verify local configuration.\n');
  process.exitCode = 1;
});
