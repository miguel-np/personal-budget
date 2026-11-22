const SUPPORTED_DOCUMENT_MIMES = new Set(['text/html', 'application/xhtml+xml', 'text/plain']);

function mimeType(value) {
  return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
}

function isoTimestamp(value) {
  if (value === null || value === undefined || value === '') return { status: 'missing', value: null };
  if (typeof value !== 'string') return { status: 'invalid', value: null };
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return { status: 'invalid', value: null };
  const normalized = new Date(timestamp).toISOString();
  return normalized === value
    ? { status: 'valid', value: normalized }
    : { status: 'invalid', value: null };
}

function observedHost(value) {
  if (typeof value !== 'string') return null;
  try { return new URL(value).hostname.toLowerCase(); } catch { return null; }
}

/**
 * Keep only a public HTTPS URL for the exact host under test. Remove query and
 * fragment data by default; preserve only a validated public BOE identifier,
 * which is required to identify its consolidated document endpoint.
 */
export function sanitizePublicSourceUrl(value, expectedHost) {
  if (typeof value !== 'string' || typeof expectedHost !== 'string') return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  const host = expectedHost.toLowerCase();
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== host ||
      url.username || url.password || url.port) return null;

  const sanitized = new URL(url.origin + url.pathname);
  if (['boe.es', 'www.boe.es'].includes(host) && url.pathname === '/buscar/act.php') {
    const identifier = url.searchParams.get('id');
    if (typeof identifier === 'string' && /^BOE-A-\\d{4}-\\d{1,8}$/.test(identifier)) {
      sanitized.searchParams.set('id', identifier);
    }
  }
  return sanitized.toString();
}

function safeFetchEvidence(fetch) {
  return {
    endpoint: typeof fetch?.endpoint === 'string' ? fetch.endpoint.slice(0, 160) : null,
    httpStatus: Number.isSafeInteger(fetch?.httpStatus) ? fetch.httpStatus : null,
    contentType: typeof fetch?.contentType === 'string' ? fetch.contentType.slice(0, 120) : null,
    bytesReceived: Number.isSafeInteger(fetch?.bytesReceived) && fetch.bytesReceived >= 0 ? fetch.bytesReceived : null,
    latencyMs: Number.isSafeInteger(fetch?.latencyMs) && fetch.latencyMs >= 0 ? fetch.latencyMs : null,
    outcome: fetch?.outcome === 'completed' || fetch?.outcome === 'failed' ? fetch.outcome : 'unknown',
  };
}

function safeTemporalEvidence(temporal) {
  if (!temporal || typeof temporal !== 'object') return null;
  const fields = [
    'assessment', 'referenceDate', 'publicationDate', 'effectiveDate',
    'derogationDate', 'annulmentDate', 'lastRegistryUpdate',
  ];
  return Object.fromEntries(fields.map((field) => [
    field,
    typeof temporal[field] === 'string' ? temporal[field] : null,
  ]));
}

function safeHistoricalEvidence(historical) {
  if (!historical || typeof historical !== 'object') return null;
  return {
    status: historical.status === 'reconstructed' ? 'reconstructed' : 'insufficient',
    blockCount: Array.isArray(historical.blocks) ? historical.blocks.length : 0,
    blockStatuses: Array.isArray(historical.blocks)
      ? historical.blocks.map((block) => typeof block?.status === 'string' ? block.status : 'unknown')
      : [],
  };
}

/**
 * Produce a sanitized evidence row and a conservative acceptance decision.
 * A partial BOE extraction is useful evidence, but cannot count as a complete
 * host acceptance because its official temporal/analysis contract is missing.
 */
export function buildSourceAcceptanceEvidence(source, expectedHost) {
  const host = observedHost(source?.url);
  const sourceUrl = sanitizePublicSourceUrl(source?.url, expectedHost);
  const publishedAt = isoTimestamp(source?.publishedAt);
  const modifiedAt = isoTimestamp(source?.modifiedAt);
  const document = source?.document && typeof source.document === 'object' ? source.document : null;
  const fetches = Array.isArray(document?.fetches) ? document.fetches : [];
  const documentMime = mimeType(document?.contentType);
  const hasSuccessfulTextFetch = fetches.some((fetch) =>
    fetch?.outcome === 'completed' &&
    fetch?.httpStatus === 200 &&
    Number.isSafeInteger(fetch?.bytesReceived) && fetch.bytesReceived > 0 &&
    SUPPORTED_DOCUMENT_MIMES.has(mimeType(fetch?.contentType)));
  const hasDocumentText = Number.isSafeInteger(document?.textLength) && document.textLength > 0;
  const retrievedAt = isoTimestamp(document?.retrievedAt);
  const metadataValid = publishedAt.status !== 'invalid' && modifiedAt.status !== 'invalid';

  let acceptanceStatus = 'not_retrieved';
  if (!sourceUrl || source?.sourceAuthority === 'external' || !metadataValid ||
      typeof source?.title !== 'string' || source.title.trim().length === 0) {
    acceptanceStatus = 'rejected';
  } else if (document?.status === 'partial') {
    acceptanceStatus = 'partial';
  } else if (document?.status === 'unavailable' || document?.status === 'unsupported') {
    acceptanceStatus = document.status;
  } else if (document?.status === 'retrieved') {
    const validType = document?.documentType === 'boe_consolidated_legislation' ||
      document?.documentType === 'official_html';
    acceptanceStatus = validType && retrievedAt.status === 'valid' &&
      SUPPORTED_DOCUMENT_MIMES.has(documentMime) && hasDocumentText && hasSuccessfulTextFetch
      ? 'accepted'
      : 'rejected';
  }

  const limitations = Array.isArray(document?.limitations)
    ? document.limitations.filter((item) => typeof item === 'string').slice(0, 20).map((item) => item.slice(0, 400))
    : [];

  return {
    host,
    sourceObserved: host === expectedHost,
    sourceUrl,
    sourceAuthority: typeof source?.sourceAuthority === 'string' ? source.sourceAuthority : null,
    sourceKind: typeof source?.sourceKind === 'string' ? source.sourceKind : null,
    publishedAt: publishedAt.value,
    publishedAtStatus: publishedAt.status,
    modifiedAt: modifiedAt.value,
    modifiedAtStatus: modifiedAt.status,
    acceptanceStatus,
    documentAccepted: acceptanceStatus === 'accepted',
    document: document ? {
      status: typeof document.status === 'string' ? document.status : 'unknown',
      documentType: typeof document.documentType === 'string' ? document.documentType : null,
      retrievedAt: retrievedAt.value,
      contentType: typeof document.contentType === 'string' ? document.contentType.slice(0, 120) : null,
      textLength: Number.isSafeInteger(document.textLength) && document.textLength >= 0 ? document.textLength : 0,
      temporal: safeTemporalEvidence(document.temporal),
      historical: safeHistoricalEvidence(document.historical),
      fetches: fetches.slice(0, 12).map(safeFetchEvidence),
      limitations,
    } : null,
  };
}
