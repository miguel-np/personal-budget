import { writeFile } from 'node:fs/promises';

const baseValue = process.env.PERSONAL_BUDGET_ACCEPTANCE_API_URL;
const bearer = process.env.PERSONAL_BUDGET_ACCEPTANCE_BEARER_TOKEN;
if (!baseValue) throw new Error('PERSONAL_BUDGET_ACCEPTANCE_API_URL is required.');
const base = new URL(baseValue);
if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash ||
  (base.pathname !== '/' && base.pathname !== '')) {
  throw new Error('The acceptance target must be an HTTPS origin without credentials, path, query or fragment.');
}
const headers = {
  accept: 'application/json',
  'content-type': 'application/json',
  ...(bearer ? { authorization: 'Bearer ' + bearer } : {}),
};
const groups = [
  { host: 'boe.es', domain: 'boe.es', allowedDomains: ['boe.es'], query: 'site:boe.es texto consolidado Ley 39/2015 BOE' },
  { host: 'www.boe.es', domain: 'boe.es', allowedDomains: ['boe.es'], query: 'site:www.boe.es publicación oficial Ley 39/2015' },
  { host: 'sede.agenciatributaria.gob.es', domain: 'agenciatributaria.gob.es', allowedDomains: ['agenciatributaria.gob.es'], query: 'site:sede.agenciatributaria.gob.es manual IRPF información oficial' },
  { host: 'hacienda.gob.es', domain: 'hacienda.gob.es', allowedDomains: ['hacienda.gob.es'], query: 'site:hacienda.gob.es normativa tributaria publicaciones oficiales' },
  { host: 'www.hacienda.gob.es', domain: 'hacienda.gob.es', allowedDomains: ['hacienda.gob.es'], query: 'site:www.hacienda.gob.es información tributaria oficial' },
  { host: 'petete.tributos.hacienda.gob.es', domain: 'petete.tributos.hacienda.gob.es', allowedDomains: ['petete.tributos.hacienda.gob.es'], query: 'site:petete.tributos.hacienda.gob.es consultas vinculantes DGT IRPF' },
  { host: 'sede.tributos.hacienda.gob.es', domain: 'sede.tributos.hacienda.gob.es', allowedDomains: ['hacienda.gob.es'], query: 'site:sede.tributos.hacienda.gob.es consultas tributarias DGT' },
  { host: 'serviciostelematicosext.hacienda.gob.es', domain: 'serviciostelematicosext.hacienda.gob.es', allowedDomains: ['serviciostelematicosext.hacienda.gob.es'], query: 'site:serviciostelematicosext.hacienda.gob.es resoluciones TEAC' },
  { host: 'sede.tea.hacienda.gob.es', domain: 'sede.tea.hacienda.gob.es', allowedDomains: ['sede.tea.hacienda.gob.es'], query: 'site:sede.tea.hacienda.gob.es criterios y resoluciones TEAC' },
  { host: 'seg-social.es', domain: 'seg-social.es', allowedDomains: ['seg-social.es'], query: 'site:seg-social.es cotización Seguridad Social normativa' },
  { host: 'www.seg-social.es', domain: 'seg-social.es', allowedDomains: ['seg-social.es'], query: 'site:www.seg-social.es información oficial Seguridad Social' },
  { host: 'sede.seg-social.gob.es', domain: 'sede.seg-social.gob.es', allowedDomains: ['seg-social.gob.es'], query: 'site:sede.seg-social.gob.es sede electrónica Seguridad Social cotización' },
  { host: 'portal.seg-social.gob.es', domain: 'seg-social.gob.es', allowedDomains: ['seg-social.gob.es'], query: 'site:portal.seg-social.gob.es portal importass cotización' },
  { host: 'xunta.gal', domain: 'xunta.gal', allowedDomains: ['xunta.gal'], query: 'site:xunta.gal Diario Oficial de Galicia DOG normativa' },
  { host: 'www.xunta.gal', domain: 'xunta.gal', allowedDomains: ['xunta.gal'], query: 'site:www.xunta.gal Diario Oficial de Galicia publicación' },
  { host: 'sede.xunta.gal', domain: 'sede.xunta.gal', allowedDomains: ['xunta.gal'], query: 'site:sede.xunta.gal sede electrónica Xunta normativa' },
  { host: 'facenda.xunta.gal', domain: 'facenda.xunta.gal', allowedDomains: ['xunta.gal'], query: 'site:facenda.xunta.gal Facenda Galicia normativa tributaria' },
  { host: 'lex.gal', domain: 'lex.gal', allowedDomains: ['lex.gal'], query: 'site:lex.gal normativa gallega consolidada' },
  { host: 'www.lex.gal', domain: 'lex.gal', allowedDomains: ['lex.gal'], query: 'site:www.lex.gal legislación de Galicia texto consolidado' },
  { host: 'cnmv.es', domain: 'cnmv.es', allowedDomains: ['cnmv.es'], query: 'site:cnmv.es normativa CNMV inversores' },
  { host: 'www.cnmv.es', domain: 'cnmv.es', allowedDomains: ['cnmv.es'], query: 'site:www.cnmv.es información y normativa CNMV' },
  { host: 'bde.es', domain: 'bde.es', allowedDomains: ['bde.es'], query: 'site:bde.es normativa Banco de España' },
  { host: 'www.bde.es', domain: 'bde.es', allowedDomains: ['bde.es'], query: 'site:www.bde.es publicaciones Banco de España' },
  { host: 'sedeelectronica.bde.es', domain: 'bde.es', allowedDomains: ['bde.es'], query: 'site:sedeelectronica.bde.es sede electrónica Banco de España normativa' }
];
const report = { startedAt: new Date().toISOString(), apiOrigin: base.origin, status: null, groups: [], privacy: {
  acceptanceRequestsUseOnlyStaticPublicQueries: true,
  acceptanceRequestsContainNoUserFinancialData: true,
  bearerTokenOmittedFromReport: true,
  backendOutboundPayloadObserved: false,
  deployedApiLogsInspected: false,
  searxngLogsInspected: false,
  status: 'requires_manual_review',
  pendingChecks: [
    'Inspect the deployed API outbound request at the SearXNG boundary and confirm it contains only the explicitly approved query and configured filters.',
    'Inspect deployed API and SearXNG logs for accidental financial context, identifiers, conversation text, document bodies or sensitive snippets.',
  ],
}, outcome: 'incomplete', hostOutcome: 'incomplete', acceptanceComplete: false };
const fetchJson = async (url, options = {}) => {
  const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers ?? {}) }, signal: AbortSignal.timeout(30_000), redirect: 'error' });
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) throw new Error('Expected application/json response.');
  const body = await response.json();
  return { response, contentType, body };
};
const statusResult = await fetchJson(new URL('/api/v1/assistant/web-search/status', base));
report.status = { httpStatus: statusResult.response.status, enabled: statusResult.body.enabled === true, provider: statusResult.body.provider ?? null };
if (!statusResult.response.ok || statusResult.body.enabled !== true || statusResult.body.provider !== 'SearXNG') {
  throw new Error('The deployed backend does not report enabled SearXNG-backed web research.');
}
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
const allGroupsHealthy = report.groups.every((group) => group.status === 'accepted');
const allNegativeProbesHealthy = report.negativeProbes.every((probe) => probe.status === 'accepted');
report.hostOutcome = allGroupsHealthy && allNegativeProbesHealthy && acceptedHosts.size === expectedHosts.length ? 'accepted' : 'partial';
// Network/log privacy evidence is not available to this runner. Never turn static test inputs
// into a claim about the deployed API's outbound payload or its production log sinks.
report.outcome = report.hostOutcome === 'accepted' ? 'hosts_accepted_privacy_review_pending' : 'partial';
report.acceptanceComplete = false;
await writeFile('web-search-live-acceptance-report.json', JSON.stringify(report, null, 2) + '\n', { flag: 'w' });
await writeFile('web-search-live-acceptance-summary.md', [
  '# Live web-search acceptance', '',
  '- Started: ' + report.startedAt,
  '- Finished: ' + report.finishedAt,
  '- Backend: ' + report.apiOrigin,
  '- Provider: ' + report.status.provider,
  '- Host outcome: ' + report.hostOutcome,
  '- Overall outcome: ' + report.outcome,
  '- Exact approved hosts with successful document extraction: ' + acceptedHosts.size + '/' + expectedHosts.length,
  '- Acceptance requests contain only fixed public test queries; no user financial data is submitted by this script.',
  '- Privacy review: pending (the runner cannot inspect the deployed API outbound payload or production API/SearXNG logs).',
  '- Required manual checks: ' + report.privacy.pendingChecks.join(' '),
  '- Raw query text, document bodies and credentials are not included in this report.',
  '',
  '| Filter | Expected hosts | HTTP / MIME | Sources | Result |',
  '|---|---|---|---:|---|',
  ...report.groups.map((group) => '| ' + group.domain + ' | ' + group.expectedHosts.join(', ') + ' | ' +
    (group.httpStatus ?? '—') + ' / ' + (group.responseMime ?? '—') + ' | ' + (group.sourceCount ?? 0) + ' | ' + group.status + ' |'),
  '',
  '## Negative and classification probes',
  ...report.negativeProbes.map((probe) => '- ' + probe.id + ': ' + probe.status + ' (' + (probe.sourceCount ?? 0) + ' sources)'),
  '',
  'The report is an operational observation for this run. A host not observed is not accepted; it is not evidence that the host is unavailable or unsafe.',
  '',
].join('\n') + '\n');
if (report.hostOutcome !== 'accepted') {
  console.error('Live host acceptance was partial. Missing or rejected hosts remain unaccepted in the report.');
  process.exitCode = 1;
} else {
  console.log('All configured host checks passed. Overall acceptance remains incomplete until the manual privacy review is recorded.');
}
