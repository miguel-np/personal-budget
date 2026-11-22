export function safeStartupFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error type';
  const errorCode = (error as NodeJS.ErrnoException).code;
  const safeCode = typeof errorCode === 'string' && /^[A-Z0-9_]{1,64}$/.test(errorCode)
    ? ' [' + errorCode + ']'
    : '';
  const stackFrames = (error.stack ?? '').split('\n').slice(1, 7)
    .map((line) => line.trim())
    .filter((line) => /^at [A-Za-z0-9_$.[\]()/\\ :<>@%-]+$/.test(line))
    .join(' <- ');
  return (error.name || 'Error') + safeCode + (stackFrames ? ' at ' + stackFrames : '');
}
