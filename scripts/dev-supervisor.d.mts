import type { ChildProcess, SpawnOptions } from 'node:child_process';

export interface DevProcessSupervisorOptions {
  scripts: string[];
  npmExecPath: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  killProcess?: (pid: number, signal?: NodeJS.Signals) => void;
  onExitCode?: (code: number) => void;
  onError?: (message: string) => void;
}

export interface DevProcessSupervisor {
  stop(signal?: NodeJS.Signals): void;
  readonly stopping: boolean;
}

export declare function startDevProcesses(
  options: DevProcessSupervisorOptions
): DevProcessSupervisor;
