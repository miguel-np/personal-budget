import { spawn } from 'node:child_process';

export function startDevProcesses({
  scripts,
  npmExecPath,
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  spawnProcess = spawn,
  killProcess = (pid, signal) => process.kill(pid, signal),
  onExitCode = (code) => {
    process.exitCode = code;
  },
  onError = (message) => {
    process.stderr.write(message + '\n');
  }
}) {
  if (!Array.isArray(scripts) || scripts.length === 0) {
    throw new TypeError('At least one npm script is required.');
  }
  if (typeof npmExecPath !== 'string' || npmExecPath.trim().length === 0) {
    throw new TypeError('npm_execpath is missing. Run this command through npm.');
  }

  let stopping = false;
  const entries = [];

  const stop = (signal = 'SIGTERM') => {
    if (stopping) return;
    stopping = true;

    for (const entry of entries) {
      if (entry.exited || !entry.child.pid) continue;

      if (platform === 'win32') {
        try {
          const killer = spawnProcess(
            'taskkill',
            ['/PID', String(entry.child.pid), '/T', '/F'],
            { stdio: 'ignore', windowsHide: true }
          );
          killer.once('error', () => {
            try {
              entry.child.kill('SIGTERM');
            } catch {
              // The process may already have exited.
            }
          });
        } catch {
          try {
            entry.child.kill('SIGTERM');
          } catch {
            // The process may already have exited.
          }
        }
        continue;
      }

      try {
        // Each child has its own process group so its npm, tsx and Vite descendants
        // are stopped together without signalling this supervisor.
        killProcess(-entry.child.pid, signal);
      } catch (error) {
        if (error?.code !== 'ESRCH') {
          onError('Could not stop the process group for npm script ' + entry.script + '.');
        }
        try {
          entry.child.kill(signal);
        } catch {
          // The process may already have exited.
        }
      }
    }
  };

  for (const script of scripts) {
    let child;
    try {
      child = spawnProcess(process.execPath, [npmExecPath, 'run', script], {
        cwd,
        env,
        stdio: 'inherit',
        windowsHide: true,
        detached: platform !== 'win32'
      });
    } catch (error) {
      onError('Could not start npm script ' + script + ': ' + error.message);
      onExitCode(1);
      stop('SIGTERM');
      break;
    }

    const entry = { script, child, exited: false };
    entries.push(entry);

    child.once('error', (error) => {
      if (stopping) return;
      onError('Could not start npm script ' + script + ': ' + error.message);
      onExitCode(1);
      stop('SIGTERM');
    });

    child.once('exit', (code, signal) => {
      entry.exited = true;
      if (stopping) return;
      onExitCode(code ?? (signal ? 1 : 0));
      // A dev session is useful only while both services are available.
      stop('SIGTERM');
    });
  }

  return {
    stop,
    get stopping() {
      return stopping;
    }
  };
}
