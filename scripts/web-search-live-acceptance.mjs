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
  { domain: 'boe.es', hosts: ['boe.es', 'www.boe.es'], query: 'site:boe.es BOE Ley 39/2015 texto consolidado' },
  { domain: 'agenciatributaria.gob.es', hosts: ['sede.agenciatributaria.gob.es'], query: 'site:sede.agenciatributaria.gob.es manual IRPF oficial' },
  { domain: 'hacienda.gob.es', hosts: ['hacienda.gob.es', 'www.hacienda.gob.es'], query: 'site:hacienda.gob.es normativa tributaria oficial' },
  { domain: 'petete.tributos.hacienda.gob.es', hosts: ['petete.tributos.hacienda.gob.es', 'sede.tributos.hacienda.gob.es'], query: 'site:petete.tributos.hacienda.gob.es consultas vinculantes DGT' },
  { domain: 'serviciostelematicosext.hacienda.gob.es', hosts: ['serviciostelematicosext.hacienda.gob.es', 'sede.tea.hacienda.gob.es'], query: 'site:serviciostelematicosext.hacienda.gob.es resoluciones TEAC' },
  { domain: 'seg-social.es', hosts: ['seg-social.es', 'www.seg-social.es', 'sede.seg-social.gob.es', 'portal.seg-social.gob.es'], query: 'site:seg-social.es cotización información oficial' },
  { domain: 'xunta.gal', hosts: ['xunta.gal', 'www.xunta.gal', 'sede.xunta.gal', 'facenda.xunta.gal'], query: 'site:xunta.gal diario oficial Galicia normativa' },
  { domain: 'lex.gal', hosts: ['lex.gal', 'www.lex.gal'], query: 'site:lex.gal normativa gallega consolidada' },
  { domain: 'cnmv.es', hosts: ['cnmv.es', 'www.cnmv.es'], query: 'site:cnmv.es normativa información inversores' },
  { domain: 'bde.es', hosts: ['bde.es', 'www.bde.es', 'sedeelectronica.bde.es'], query: 'site:bde.es normativa bancaria' },
];
const report = { startedAt: new Date().toISOString(), apiOrigin: base.origin, status: null, groups: [], privacy: {
  requestBodyContainsOnlyStaticPublicQueries: true,
  bearerTokenOmittedFromReport: true,
  financialDataSent: false,
}, outcome: 'incomplete' };
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
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (let i = 0; i < groups.length; i += 1) {
  const group = groups[i];
  const started = Date.now();
  try {
    const result = await fetchJson(new URL('/api/v1/assistant/web-search', base), {
      method: 'POST',
      body: JSON.stringify({ consent: true, query: group.query, mode: 'general', domains: [group.domain] }),
    });
    const data = result.body.data;
    if (!result.response.ok || !data || data.provider !== 'SearXNG' || !Array.isArray(data.sources)) {
      throw new Error('The backend response does not satisfy the web-search contract.');
    }
    const sourceRows = data.sources.map((source) => {
      let url;
      try { url = new URL(source.url); } catch { return { id: source.id ?? null, host: null, accepted: false, reason: 'invalid_url' }; }
      const host = url.hostname.toLowerCase();
      const hostAllowed = group.hosts.includes(host);
      if (hostAllowed) observedHosts.add(host);
      const document = source.document ?? null;
      return {
        id: source.id ?? null,
        host,
        accepted: hostAllowed && url.protocol === 'https:' && Boolean(source.title),
        documentStatus: document?.status ?? null,
        contentType: document?.contentType ?? null,
        textLength: Number.isSafeInteger(document?.textLength) ? document.textLength : 0,
        limitationCount: Array.isArray(document?.limitations) ? document.limitations.length : null,
      };
    });
    report.groups.push({
      domain: group.domain,
      expectedHosts: group.hosts,
      httpStatus: result.response.status,
      responseMime: result.contentType,
      latencyMs: Date.now() - started,
      sourceCount: sourceRows.length,
      sources: sourceRows,
      acceptedHosts: sourceRows.filter((row) => row.accepted).map((row) => row.host),
      status: sourceRows.some((row) => row.accepted) ? 'observed' : 'not_observed',
    });
  } catch (error) {
    report.groups.push({
      domain: group.domain,
      expectedHosts: group.hosts,
      latencyMs: Date.now() - started,
      status: 'failed',
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
  }
  if (i < groups.length - 1) await delay(10_500);
}
const expectedHosts = groups.flatMap((group) => group.hosts);
report.finishedAt = new Date().toISOString();
report.hostCoverage = expectedHosts.map((host) => ({ host, observed: observedHosts.has(host) }));
report.observedHostCount = observedHosts.size;
report.expectedHostCount = expectedHosts.length;
const allGroupsHealthy = report.groups.every((group) => group.status === 'observed');
report.outcome = allGroupsHealthy && observedHosts.size === expectedHosts.length ? 'accepted' : 'partial';
await writeFile('web-search-live-acceptance-report.json', JSON.stringify(report, null, 2) + '\n', { flag: 'w' });
await writeFile('web-search-live-acceptance-summary.md', [
  '# Live web-search acceptance', '',
  '- Started: ' + report.startedAt,
  '- Finished: ' + report.finishedAt,
  '- Backend: ' + report.apiOrigin,
  '- Provider: ' + report.status.provider,
  '- Status: ' + report.outcome,
  '- Exact approved hosts observed: ' + observedHosts.size + '/' + expectedHosts.length,
  '- Financial data sent: no (static public queries only)',
  '- Raw query text, document bodies and credentials are not included in this report.',
  '',
  '| Filter | Expected hosts | HTTP / MIME | Sources | Result |',
  '|---|---|---|---:|---|',
  ...report.groups.map((group) => '| ' + group.domain + ' | ' + group.expectedHosts.join(', ') + ' | ' +
    (group.httpStatus ?? '—') + ' / ' + (group.responseMime ?? '—') + ' | ' + (group.sourceCount ?? 0) + ' | ' + group.status + ' |'),
  '',
  'The report is an operational observation for this run. A host not observed is not accepted; it is not evidence that the host is unavailable or unsafe.',
  '',
].join('\n') + '\n');
if (report.outcome !== 'accepted') {
  console.error('Live acceptance was partial. The reports describe observed failures without treating missing hosts as accepted.');
  process.exitCode = 1;
}
