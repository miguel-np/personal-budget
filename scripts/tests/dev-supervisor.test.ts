import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

// @ts-ignore The supervisor is an executable MJS module without a public TS surface.
import { startDevProcesses } from '../dev-supervisor.mjs';

function createChild(pid: number) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.kill = vi.fn();
  return child;
}

describe('development process supervisor', () => {
  it('starts each npm script through the current Node and npm executables', () => {
    const api = createChild(101);
    const web = createChild(102);
    const spawnProcess = vi.fn()
      .mockReturnValueOnce(api)
      .mockReturnValueOnce(web);

    startDevProcesses({
      scripts: ['dev:api', 'dev:web'],
      npmExecPath: '/npm/bin/npm-cli.js',
      cwd: '/workspace/personal-budget',
      platform: 'linux',
      spawnProcess
    });

    expect(spawnProcess).toHaveBeenNthCalledWith(
      1,
      process.execPath,
      ['/npm/bin/npm-cli.js', 'run', 'dev:api'],
      expect.objectContaining({
        cwd: '/workspace/personal-budget',
        stdio: 'inherit',
        detached: true
      })
    );
    expect(spawnProcess).toHaveBeenNthCalledWith(
      2,
      process.execPath,
      ['/npm/bin/npm-cli.js', 'run', 'dev:web'],
      expect.objectContaining({
        cwd: '/workspace/personal-budget',
        stdio: 'inherit',
        detached: true
      })
    );
  });

  it('stops the remaining service when one npm script exits', () => {
    const api = createChild(101);
    const web = createChild(102);
    const spawnProcess = vi.fn()
      .mockReturnValueOnce(api)
      .mockReturnValueOnce(web);
    const killProcess = vi.fn();
    const onExitCode = vi.fn();

    const supervisor = startDevProcesses({
      scripts: ['dev:api', 'dev:web'],
      npmExecPath: '/npm/bin/npm-cli.js',
      platform: 'linux',
      spawnProcess,
      killProcess,
      onExitCode
    });

    api.emit('exit', 7, null);

    expect(onExitCode).toHaveBeenCalledWith(7);
    expect(killProcess).toHaveBeenCalledTimes(1);
    expect(killProcess).toHaveBeenCalledWith(-102, 'SIGTERM');
    expect(supervisor.stopping).toBe(true);
  });

  it('terminates the full process tree on Windows', () => {
    const api = createChild(201);
    const web = createChild(202);
    const taskkill = createChild(999);
    const spawnProcess = vi.fn()
      .mockReturnValueOnce(api)
      .mockReturnValueOnce(web)
      .mockReturnValueOnce(taskkill);

    startDevProcesses({
      scripts: ['dev:api', 'dev:web'],
      npmExecPath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
      platform: 'win32',
      spawnProcess
    });

    api.emit('exit', 0, null);

    expect(spawnProcess).toHaveBeenNthCalledWith(
      3,
      'taskkill',
      ['/PID', '202', '/T', '/F'],
      { stdio: 'ignore', windowsHide: true }
    );
  });

  it('does not signal a process group more than once', () => {
    const api = createChild(301);
    const web = createChild(302);
    const spawnProcess = vi.fn()
      .mockReturnValueOnce(api)
      .mockReturnValueOnce(web);
    const killProcess = vi.fn();

    const supervisor = startDevProcesses({
      scripts: ['dev:api', 'dev:web'],
      npmExecPath: '/npm/bin/npm-cli.js',
      platform: 'linux',
      spawnProcess,
      killProcess
    });

    supervisor.stop('SIGINT');
    supervisor.stop('SIGTERM');

    expect(killProcess).toHaveBeenCalledTimes(2);
    expect(killProcess).toHaveBeenNthCalledWith(1, -301, 'SIGINT');
    expect(killProcess).toHaveBeenNthCalledWith(2, -302, 'SIGINT');
  });

  it('stops an already-started service when the next process cannot spawn', () => {
    const api = createChild(401);
    const spawnProcess = vi.fn()
      .mockReturnValueOnce(api)
      .mockImplementationOnce(() => {
        throw new Error('spawn failed');
      });
    const killProcess = vi.fn();
    const onExitCode = vi.fn();
    const onError = vi.fn();

    const supervisor = startDevProcesses({
      scripts: ['dev:api', 'dev:web'],
      npmExecPath: '/npm/bin/npm-cli.js',
      platform: 'linux',
      spawnProcess,
      killProcess,
      onExitCode,
      onError
    });

    expect(onExitCode).toHaveBeenCalledWith(1);
    expect(onError).toHaveBeenCalledWith('Could not start npm script dev:web: spawn failed');
    expect(killProcess).toHaveBeenCalledWith(-401, 'SIGTERM');
    expect(supervisor.stopping).toBe(true);
  });

  it('fails clearly when npm has not provided its executable path', () => {
    expect(() => startDevProcesses({
      scripts: ['dev:api'],
      npmExecPath: '',
      spawnProcess: vi.fn()
    })).toThrow('npm_execpath is missing. Run this command through npm.');
  });
});
