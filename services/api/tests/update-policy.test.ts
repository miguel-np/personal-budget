import { describe, expect, it } from 'vitest';
import { assertSupportedTransition, parseActualImage, recoveryMode } from '../../../scripts/update-policy.js';
import type { TestedTransition } from '../../../scripts/update-policy.js';

const transitions: readonly TestedTransition[] = [
  { from: '26.9.0', to: '26.10.0', status: 'verified', evidence: 'Synthetic upgrade acceptance workflow' },
];

describe('Actual safe-update policy', () => {
  it('accepts only the exact official image repository and pinned version', () => {
    expect(parseActualImage('actualbudget/actual-server:26.10.0')).toEqual({
      image: 'actualbudget/actual-server:26.10.0', version: '26.10.0',
    });
    expect(() => parseActualImage('actualbudget/actual-server:latest')).toThrow(/exact semantic version/i);
    expect(() => parseActualImage('untrusted.example/actual-server:26.10.0')).toThrow(/official repository/i);
    expect(() => parseActualImage('actualbudget/actual-server:26.10')).toThrow(/exact semantic version/i);
  });

  it('rejects every transition that is not explicitly in the tested matrix', () => {
    expect(assertSupportedTransition('actualbudget/actual-server:26.9.0', 'actualbudget/actual-server:26.10.0', transitions))
      .toEqual({ current: '26.9.0', target: '26.10.0' });
    expect(() => assertSupportedTransition('actualbudget/actual-server:26.10.0', 'actualbudget/actual-server:26.11.0', transitions))
      .toThrow(/not in the tested compatibility matrix/i);
    expect(() => assertSupportedTransition('actualbudget/actual-server:26.10.0', 'actualbudget/actual-server:26.10.0', transitions))
      .toThrow(/already configured/i);
  });

  it('never attempts automatic old-image start after the new image may have touched data', () => {
    expect(recoveryMode('before-pull')).toBe('restart-previous');
    expect(recoveryMode('after-pull')).toBe('restart-previous');
    expect(recoveryMode('after-start')).toBe('stop-and-explicitly-restore');
  });
});
