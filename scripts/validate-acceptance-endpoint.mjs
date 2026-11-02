import { validateAcceptanceEndpoint } from './acceptance-endpoint.mjs';

const value = process.argv[2] ?? process.env.PERSONAL_BUDGET_ACCEPTANCE_API_URL;
await validateAcceptanceEndpoint(value);
console.log('Acceptance endpoint is HTTPS and resolves only to globally routable addresses.');
