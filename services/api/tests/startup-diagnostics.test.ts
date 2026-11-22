import { describe, expect, it } from 'vitest';
import { safeStartupFailure } from '../src/startup-diagnostics.js';

describe('safe API startup diagnostics', () => {
  it('reports startup stack locations without exposing error messages', () => {
    const error = new Error('password=secret; ACTUAL_SERVER_PASSWORD=private');
    error.stack = `Error: password=secret
    at start (services/api/src/main.ts:42:7)
    at async main (services/api/src/main.ts:50:3)`;
    const diagnostic = safeStartupFailure(error);
    expect(diagnostic).toContain('Error');
    expect(diagnostic).toContain('services/api/src/main.ts:42:7');
    expect(diagnostic).toContain('services/api/src/main.ts:50:3');
    expect(diagnostic).not.toContain('password=secret');
    expect(diagnostic).not.toContain('private');
  });

  it('does not trust error codes outside a safe identifier format', () => {
    const error = new Error('unsafe');
    Object.assign(error, { code: 'secret=/tmp/private' });
    expect(safeStartupFailure(error)).not.toContain('secret');
  });
});
