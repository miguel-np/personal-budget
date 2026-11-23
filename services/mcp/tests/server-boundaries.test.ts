import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalTimeout = process.env.PERSONAL_BUDGET_MCP_API_TIMEOUT_MS;
const originalApiUrl = process.env.PERSONAL_BUDGET_API_URL;
const originalExitCode = process.exitCode;

function restoreEnvironment() {
  if (originalTimeout === undefined) delete process.env.PERSONAL_BUDGET_MCP_API_TIMEOUT_MS;
  else process.env.PERSONAL_BUDGET_MCP_API_TIMEOUT_MS = originalTimeout;
  if (originalApiUrl === undefined) delete process.env.PERSONAL_BUDGET_API_URL;
  else process.env.PERSONAL_BUDGET_API_URL = originalApiUrl;
  process.exitCode = originalExitCode;
  vi.resetModules();
}

afterEach(() => {
  vi.unstubAllEnvs();
  restoreEnvironment();
});

describe('MCP runtime configuration and startup', () => {
  it('uses loopback and timeout defaults when environment values are absent', async () => {
    delete process.env.PERSONAL_BUDGET_MCP_API_TIMEOUT_MS;
    delete process.env.PERSONAL_BUDGET_API_URL;
    vi.resetModules();

    const runtime = await import('../runtime-config.mjs');

    expect(runtime.TIMEOUT).toBe(5000);
    expect(runtime.timeoutValid).toBe(true);
    expect(runtime.baseValid).toBe(true);
    expect(runtime.base).toBe('http://127.0.0.1:3000');
  });

  it('refuses to start when the configured timeout is invalid', async () => {
    vi.stubEnv('PERSONAL_BUDGET_MCP_API_TIMEOUT_MS', 'not-an-integer');
    vi.stubEnv('PERSONAL_BUDGET_API_URL', 'http://127.0.0.1:3000');
    vi.resetModules();

    const { startMcpStdio } = await import('../server.mjs');
    const errors = new PassThrough();
    let errorText = '';
    errors.on('data', chunk => { errorText += chunk.toString(); });

    expect(startMcpStdio({
      inputStream: new PassThrough(),
      outputStream: new PassThrough(),
      errorStream: errors
    })).toBeNull();
    expect(errorText).toContain('PERSONAL_BUDGET_MCP_API_TIMEOUT_MS');
    expect(process.exitCode).toBe(2);
  });

  it('refuses to start when the API URL is not loopback', async () => {
    vi.stubEnv('PERSONAL_BUDGET_MCP_API_TIMEOUT_MS', '5000');
    vi.stubEnv('PERSONAL_BUDGET_API_URL', 'https://example.invalid');
    vi.resetModules();

    const { startMcpStdio } = await import('../server.mjs');
    const errors = new PassThrough();
    let errorText = '';
    errors.on('data', chunk => { errorText += chunk.toString(); });

    expect(startMcpStdio({
      inputStream: new PassThrough(),
      outputStream: new PassThrough(),
      errorStream: errors
    })).toBeNull();
    expect(errorText).toContain('MCP API URL must use loopback');
    expect(process.exitCode).toBe(2);
  });

  it('does not write JSON-RPC responses for notifications and sanitizes rejected handlers', async () => {
    vi.stubEnv('PERSONAL_BUDGET_MCP_API_TIMEOUT_MS', '5000');
    vi.stubEnv('PERSONAL_BUDGET_API_URL', 'http://127.0.0.1:3000');
    vi.resetModules();

    const { startMcpStdio } = await import('../server.mjs');
    const input = new PassThrough();
    const output = new PassThrough();
    let writtenOutput = '';
    output.on('data', chunk => { writtenOutput += chunk.toString(); });
    const reader = createInterface({ input: output, crlfDelay: Infinity });
    const server = startMcpStdio({
      inputStream: input,
      outputStream: output,
      handler: async (message: unknown) => {
        if (
          typeof message === 'object'
          && message !== null
          && 'method' in message
          && message.method === 'notifications/initialized'
        ) return null;
        throw new Error('sensitive internal detail');
      }
    });

    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await new Promise(resolve => setImmediate(resolve));
    expect(writtenOutput).toBe('');

    const responseLine = once(reader, 'line');
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }) + '\n');
    expect(JSON.parse((await responseLine)[0])).toEqual({
      jsonrpc: '2.0',
      id: 9,
      error: { code: -32603, message: 'Internal error' }
    });

    server?.close();
    reader.close();
    input.destroy();
    output.destroy();
  });

  it('sanitizes unexpected prompt and tool parser exceptions', async () => {
    vi.resetModules();
    const { createMcpHandler } = await import('../server.mjs');
    const handler = createMcpHandler();
    const privateArguments = new Proxy({}, {
      ownKeys() { throw new Error('sensitive internal detail'); }
    });

    const prompt = await handler({
      jsonrpc: '2.0',
      id: 1,
      method: 'prompts/get',
      params: { name: 'wealth_review', arguments: privateArguments }
    });
    expect(prompt).toMatchObject({
      error: { code: -32602, message: 'Invalid prompt arguments.' }
    });

    const tool = await handler({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_monthly_summary', arguments: privateArguments }
    });
    expect(tool).toMatchObject({
      result: { isError: true, content: [{ text: 'Local finance tool failed.' }] }
    });
    expect(JSON.stringify({ prompt, tool })).not.toContain('sensitive internal detail');
  });

  it('rejects direct CLI startup with a non-loopback API URL', async () => {
    const entrypoint = fileURLToPath(new URL('../server.mjs', import.meta.url));
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [entrypoint], {
        env: {
          ...process.env,
          PERSONAL_BUDGET_MCP_API_TIMEOUT_MS: '5000',
          PERSONAL_BUDGET_API_URL: 'https://example.invalid'
        },
        stdio: ['ignore', 'ignore', 'pipe']
      });
      let stderr = '';
      if (!child.stderr) {
        reject(new Error('Unable to capture the MCP child-process stderr.'));
        return;
      }
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', code => resolve({ code, stderr }));
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('MCP API URL must use loopback');
  });
});
