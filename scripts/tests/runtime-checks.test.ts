import { describe, expect, it } from 'vitest';
import { parseDotEnv, safeConfigFailure, supportsNodeVersion, supportsNpmVersion } from '../runtime-checks.js';
describe('local runtime diagnostics', () => {
  it('parses quoted values and ignores comments', () => {
    expect(parseDotEnv('# note\nAPP_PORT=3000\nOLLAMA_MODEL=""\nACTUAL_SERVER_PASSWORD="do-not-print"\nexport AI_ENABLED=false\n')).toEqual({ APP_PORT:'3000', OLLAMA_MODEL:'', ACTUAL_SERVER_PASSWORD:'do-not-print', AI_ENABLED:'false' });
  });
  it('enforces the documented runtime baseline', () => {
    expect(supportsNodeVersion('v26.13.1')).toBe(true);
    expect(supportsNodeVersion('26.13.2')).toBe(true);
    expect(supportsNodeVersion('26.13.0')).toBe(false);
    expect(supportsNodeVersion('26.12.9')).toBe(false);
    expect(supportsNodeVersion('24.22.3')).toBe(false);
    expect(supportsNodeVersion('27.0.0')).toBe(false);
    expect(supportsNodeVersion('not-a-version')).toBe(false);
    expect(supportsNpmVersion('11.20.0')).toBe(true);
    expect(supportsNpmVersion('11.19.9')).toBe(false);
    expect(supportsNpmVersion('12.0.0')).toBe(true);
  });
  it('reports variable names but never invalid values', () => {
    const message = safeConfigFailure({ issues:[{path:['ACTUAL_SERVER_PASSWORD'],message:'bad-secret-value'},{path:['APP_PORT'],message:'bad-port-value'}] });
    expect(message).toContain('ACTUAL_SERVER_PASSWORD'); expect(message).toContain('APP_PORT');
    expect(message).not.toContain('bad-secret-value'); expect(message).not.toContain('bad-port-value');
  });
  it('keeps unknown diagnostics generic', () => { expect(safeConfigFailure(new Error('password=secret'))).not.toContain('password=secret'); });
});
