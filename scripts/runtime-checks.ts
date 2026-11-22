export type EnvironmentValues = Record<string, string>;
export function parseDotEnv(source: string): EnvironmentValues {
  const values: EnvironmentValues = {};
  for (const sourceLine of source.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2] ?? '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    values[match[1]!] = value;
  }
  return values;
}
function versionParts(version: string): [number, number, number] | null {
  const match = version.trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
export function supportsNodeVersion(version: string): boolean {
  const parts = versionParts(version);
  if (!parts) return false;
  const [major, minor, patch] = parts;
  return major === 26 && (minor > 13 || (minor === 13 && patch >= 1));
}
export function supportsNpmVersion(version: string): boolean {
  const parts = versionParts(version);
  if (!parts) return false;
  const [major, minor] = parts;
  return major > 11 || (major === 11 && minor >= 20);
}
export function safeConfigFailure(error: unknown): string {
  const candidate = error as { issues?: readonly { path?: readonly (string | number)[] }[] };
  const keys = [...new Set((candidate?.issues ?? []).map((issue) => issue.path?.[0]).filter((key): key is string => typeof key === 'string'))].sort();
  if (!keys.length) return 'Configuración inválida. Revisa las variables documentadas en .env.example; no se muestran valores ni secretos.';
  return 'Configuración inválida. Revisa estas variables: ' + keys.join(', ') + '. No se muestran sus valores.';
}

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

