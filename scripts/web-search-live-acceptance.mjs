import { mkdir, writeFile } from 'node:fs/promises';
import { DEFAULT_LOCAL_ACCEPTANCE_API_ORIGIN, validateLocalAcceptanceOrigin } from './local-acceptance-origin.mjs';
import { WEB_SEARCH_ACCEPTANCE_GROUPS as groups } from './web-search-live-acceptance-config.mjs';

const baseValue = process.env.PERSONAL_BUDGET_LOCAL_ACCEPTANCE_API_ORIGIN ?? DEFAULT_LOCAL_ACCEPTANCE_API_ORIGIN;
const base = validateLocalAcceptanceOrigin(baseValue);
const headers = {
  accept: 'application/json',
  'content-type': 'application/json',
};
const maximumJsonBytes = 1_048_576;
const report = {
  startedAt: new Date().toISOString(),
  executionBoundary: 'loopback-only',
  apiOrigin: base.origin,
  status: null,
  groups: [],
  privacy: {
    executionBoundary: 'loopback-only',
    acceptanceRequestsUseOnlyStaticPublicQueries: true,
    acceptanceRequestsContainNoUserFinancialData: true,
    backendOutboundPayloadObserved: false,
    applicationLogsInspected: false,
    searxngLogsInspected: false,
    status: 'requires_manual_review',
    pendingChecks: [
      'Inspect the actual API-to-SearXNG request at the configured SearXNG boundary and confirm that the q value is one of the fixed public acceptance queries, with only the expected search-control parameters.',
      'Inspect the local API and SearXNG logs for accidental financial context, account or transaction identifiers, conversation text, credentials, document bodies or sensitive snippets.',
    ],
  },
  outcome: 'incomplete',
  hostOutcome: 'incomplete',
  acceptanceComplete: false,
};

const reportDirectory = '.local/acceptance';
const reportStamp = report.startedAt.replace(/[:.]/g, '-');
const reportJsonPath = reportDirectory + '/web-search-' + reportStamp + '.json';
const reportSummaryPath = reportDirectory + '/web-search-' + reportStamp + '.md';

async function writeReport() {
  report.finishedAt ??= new Date().toISOString();
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  const summary = [
    '# Local web-search acceptance',
    '',
    '- Started: ' + report.startedAt,
    '- Finished: ' + report.finishedAt,
    '- API origin: ' + report.apiOrigin + ' (validated literal loopback address)',
    '- Provider: ' + (report.status?.provider ?? 'unavailable'),
    '- Host outcome: ' + (report.hostOutcome ?? 'not_run'),
    '- Overall outcome: ' + (report.outcome ?? 'incomplete'),
    '- Exact approved hosts with successful document extraction: ' + (report.acceptedHostCount ?? 0) + '/' + (report.expectedHostCount ?? groups.length),
    '- Acceptance requests use only fixed public test queries; no user financial data is submitted by this script.',
    '- Privacy review: pending; this script cannot inspect the API outbound request or the local API/SearXNG log sinks.',
    '- Required manual checks: ' + report.privacy.pendingChecks.join(' '),
    '- Raw query text, document bodies, credentials and response snippets are not included in this report.',
    '',
    '| Expected host | HTTP / MIME | Sources | Result |',
    '|---|---|---:|---|',
    ...report.groups.map((group) => '| ' + group.expectedHosts.join(', ') + ' | ' +
      (group.httpStatus ?? '—') + ' / ' + (group.responseMime ?? '—') + ' | ' +
      (group.sourceCount ?? 0) + ' | ' + group.status + ' |'),
    '',
    '## Negative and classification probes',
    ...((report.negativeProbes ?? []).map((probe) => '- ' + probe.id + ': ' + probe.status + ' (' + (probe.sourceCount ?? 0) + ' sources)')),
    '',
    'A host not observed is not accepted; it is not evidence that the host is unavailable or unsafe.',
    'Exit code 0 means the host sweep passed. Overall acceptance remains incomplete until the manual privacy review is recorded.',
    '',
  ].join('\n') + '\n';
  await Promise.all([
    writeFile(reportJsonPath, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 }),
    writeFile(reportSummaryPath, summary, { encoding: 'utf8', mode: 0o600 }),
  ]);
  console.log('Sanitized acceptance evidence: ' + reportJsonPath + ' and ' + reportSummaryPath);
}

async function readJsonBounded(response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumJsonBytes) {
    if (response.body) await response.body.cancel().catch(() => {});
    throw new Error('Acceptance API response exceeded its configured size limit.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Acceptance API returned an empty response body.');
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximumJsonBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('Acceptance API response exceeded its configured size limit.');
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('Acceptance API returned invalid JSON.');
  }
}

const fetchJson = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: { ...headers, ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    if (response.body) await response.body.cancel().catch(() => {});
    throw new Error('Expected application/json response.');
  }
  const body = await readJsonBounded(response);
  return { response, contentType, body };
};

let statusReady = false;
try {
  const statusResult = await fetchJson(new URL('/api/v1/assistant/web-search/status', base));
  report.status = {
    httpStatus: statusResult.response.status,
    enabled: statusResult.body.enabled === true,
    provider: statusResult.body.provider ?? null,
  };
  if (!statusResult.response.ok || statusResult.body.enabled !== true || statusResult.body.provider !== 'SearXNG') {
    throw new Error('The local backend does not report enabled SearXNG-backed web research.');
  }
  statusReady = true;
} catch (error) {
  report.setupFailureType = error instanceof Error ? error.name : 'UnknownError';
  report.hostOutcome = 'not_run';
  report.outcome = 'unavailable';
  await writeReport();
  console.error('Local acceptance could not reach an API with SearXNG-backed web research enabled. No remote API endpoint was contacted.');
  process.exitCode = 1;
}

if (statusReady) {
const observedHosts = new Set();
const acceptedHosts = new Set();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (let i = 0; i < groups.length; i += 1) {
  const group = groups[i];
  const started = Date.now();
  try {
    const result = await fetchJson(new URL('/api/v1/assistant/web-search', base), {
      method: 'POST',
      body: JSON.stringify({ consent: true, query: group.query, mode: 'general', domains: group.allowedDomains }),
    });
    const data = result.body.data;
    if (!result.response.ok || !data || data.provider !== 'SearXNG' || !Array.isArray(data.sources)) {
      throw new Error('The backend response does not satisfy the web-search contract.');
    }
    const sourceRows = data.sources.map((source) => {
      let url;
      try { url = new URL(source.url); } catch { return { id: source.id ?? null, host: null, sourceObserved: false, documentAccepted: false, reason: 'invalid_url' }; }
      const host = url.hostname.toLowerCase();
      const hostAllowed = group.host === host;
      if (hostAllowed) observedHosts.add(host);
      const document = source.document ?? null;
      const fetches = Array.isArray(document?.fetches) ? document.fetches : [];
      const textFetchOk = fetches.some((fetch) => fetch?.outcome === 'completed' && fetch?.httpStatus === 200 &&
        Number.isSafeInteger(fetch?.bytesReceived) && fetch.bytesReceived > 0 &&
        (String(fetch?.contentType ?? '').toLowerCase().includes('text/html') ||
          String(fetch?.contentType ?? '').toLowerCase().includes('application/xhtml+xml') ||
          String(fetch?.contentType ?? '').toLowerCase().includes('text/plain')));
      const hasText = Number.isSafeInteger(document?.textLength) && document.textLength > 0 && (document?.status === 'retrieved' || document?.status === 'partial');
      const documentAccepted = hostAllowed && url.protocol === 'https:' && Boolean(source.title) && hasText && textFetchOk;
      if (documentAccepted) acceptedHosts.add(host);
      return {
        id: source.id ?? null, host, sourceObserved: hostAllowed, documentAccepted,
        publishedAt: source.publishedAt ?? null,
        modifiedAt: source.modifiedAt ?? null,
        documentStatus: document?.status ?? null, textLength: Number.isSafeInteger(document?.textLength) ? document.textLength : 0,
        fetches: fetches.map((fetch) => ({ endpoint: fetch.endpoint ?? null, httpStatus: fetch.httpStatus ?? null,
          contentType: fetch.contentType ?? null, bytesReceived: fetch.bytesReceived ?? 0, latencyMs: fetch.latencyMs ?? null, outcome: fetch.outcome ?? 'unknown' })),
        limitationCount: Array.isArray(document?.limitations) ? document.limitations.length : null,
      };
    });
    report.groups.push({
      domain: group.domain,
      expectedHosts: [group.host],
      httpStatus: result.response.status,
      responseMime: result.contentType,
      latencyMs: Date.now() - started,
      sourceCount: sourceRows.length,
      sources: sourceRows,
      acceptedHosts: sourceRows.filter((row) => row.documentAccepted).map((row) => row.host),
      status: sourceRows.some((row) => row.documentAccepted) ? 'accepted' : sourceRows.some((row) => row.sourceObserved) ? 'document_not_accepted' : 'not_observed',
    });
  } catch (error) {
    report.groups.push({
      domain: group.domain,
      expectedHosts: [group.host],
      latencyMs: Date.now() - started,
      status: 'failed',
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
  }
  if (i < groups.length - 1) await delay(10_500);
}
const negativeProbes = [
  { id: 'dog-gal-not-trusted-as-dog', domains: ['xunta.gal'], query: 'site:dog.gal Diario Oficial de Galicia DOG', forbiddenHosts: ['dog.gal'] },
  { id: 'external-host-excluded-by-boe-filter', domains: ['boe.es'], query: 'site:example.com Example Domain public information', forbiddenHosts: ['example.com'] },
  { id: 'unfiltered-secondary-source-classification', domains: [], query: 'site:example.com Example Domain public information', requireExternalClassification: true },
];
report.negativeProbes = [];
for (const probe of negativeProbes) {
  try {
    const response = await fetchJson(new URL('/api/v1/assistant/web-search', base), {
      method: 'POST', body: JSON.stringify({ consent: true, query: probe.query, mode: 'general', domains: probe.domains }),
    });
    const data = response.body.data;
    if (!response.response.ok || !data || data.provider !== 'SearXNG' || !Array.isArray(data.sources)) throw new Error('Invalid negative-probe response.');
    const observed = data.sources.map((source) => {
      let host = null; try { host = new URL(source.url).hostname.toLowerCase(); } catch { /* Invalid source URL remains visible as a failed probe. */ }
      return { host, sourceAuthority: source.sourceAuthority ?? null, documentRetrieved: Boolean(source.document && source.document.status === 'retrieved') };
    });
    const forbiddenObserved = probe.forbiddenHosts?.filter((forbidden) => observed.some((source) => source.host === forbidden || source.host?.endsWith('.' + forbidden))) ?? [];
    const externalClassified = observed.some((source) => source.host === 'example.com' && source.sourceAuthority === 'external' && !source.documentRetrieved);
    const accepted = probe.requireExternalClassification ? externalClassified : forbiddenObserved.length === 0;
    report.negativeProbes.push({ id: probe.id, httpStatus: response.response.status, responseMime: response.contentType,
      sourceCount: observed.length, sources: observed, forbiddenHostsObserved: forbiddenObserved,
      status: accepted ? 'accepted' : observed.length === 0 ? 'not_observed' : 'rejected' });
  } catch (error) {
    report.negativeProbes.push({ id: probe.id, status: 'failed', errorType: error instanceof Error ? error.name : 'UnknownError' });
  }
  await delay(10_500);
}
const expectedHosts = groups.map((group) => group.host);
report.finishedAt = new Date().toISOString();
report.hostCoverage = expectedHosts.map((host) => ({ host, observed: observedHosts.has(host), documentAccepted: acceptedHosts.has(host) }));
report.observedHostCount = observedHosts.size;
report.expectedHostCount = expectedHosts.length;
report.acceptedHostCount = acceptedHosts.size;
const allGroupsHealthy = report.groups.every((group) => group.status === 'accepted');
const allNegativeProbesHealthy = report.negativeProbes.every((probe) => probe.status === 'accepted');
report.hostOutcome = allGroupsHealthy && allNegativeProbesHealthy && acceptedHosts.size === expectedHosts.length ? 'accepted' : 'partial';
// Network/log privacy evidence is not available to this runner. Never turn static test inputs
// into a claim about the deployed API's outbound payload or its production log sinks.
report.outcome = report.hostOutcome === 'accepted' ? 'hosts_accepted_privacy_review_pending' : 'partial';
report.acceptanceComplete = false;
await writeReport();
if (report.hostOutcome !== 'accepted') {
  console.error('Local live host acceptance was partial. Missing or rejected hosts remain unaccepted in the report.');
  process.exitCode = 1;
} else {
  console.log('All exact host checks passed. Overall acceptance remains incomplete until the manual privacy review is recorded.');
}
}
