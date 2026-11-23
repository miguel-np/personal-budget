const configuredTimeout = process.env.PERSONAL_BUDGET_MCP_API_TIMEOUT_MS;
const parsedTimeout = configuredTimeout === undefined ? 5000 : Number(configuredTimeout);
export function isValidMcpTimeout(value) {
 return Number.isInteger(value) && value >= 100 && value <= 30000;
}
export function isLoopbackApiUrl(value) {
 try {
  const url = new URL(value);
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
   && ['http:', 'https:'].includes(url.protocol)
   && !url.username
   && !url.password;
 } catch {
  return false;
 }
}
export const timeoutValid = isValidMcpTimeout(parsedTimeout);
const configuredBase = process.env.PERSONAL_BUDGET_API_URL || 'http://127.0.0.1:3000';
export const baseValid = isLoopbackApiUrl(configuredBase);
export const TIMEOUT = timeoutValid ? parsedTimeout : 5000;
export const base = baseValid ? configuredBase : 'http://127.0.0.1:3000';
