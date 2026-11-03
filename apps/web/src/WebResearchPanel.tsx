import { useEffect, useState, type FormEvent } from 'react';

const OFFICIAL_DOMAINS = [
  'agenciatributaria.gob.es',
  'boe.es',
  'hacienda.gob.es',
  'petete.tributos.hacienda.gob.es',
  'serviciostelematicosext.hacienda.gob.es',
  'sede.tea.hacienda.gob.es',
  'lex.gal',
  'seg-social.es',
  'seg-social.gob.es',
  'xunta.gal',
  'cnmv.es',
  'bde.es',
] as const;

interface SearchStatus { enabled: boolean; provider: string; explicitConsentRequired: boolean; toolCallingRequired: boolean; maximumResults: number; }
interface SearchSource {
  id: string; title: string; url: string; domain: string; institution: string; publishedAt: string | null; modifiedAt: string | null;
  snippet: string;
  sourceKind: 'normativa' | 'normativa_consolidada_informativa' | 'criterio_administrativo' | 'organismo_oficial' | 'externa';
  sourceAuthority: 'legislation' | 'legal_consolidation' | 'dgt_criteria' | 'teac_criteria' | 'tax_administration' | 'tax_agency_guidance' | 'official_information' | 'external';
  document?: {
    status: 'retrieved' | 'partial' | 'unavailable' | 'unsupported';
    documentType: 'boe_consolidated_legislation' | 'official_html' | 'unsupported_format';
    retrievedAt: string | null;
    contentType: string | null;
    excerpt: string;
    textLength: number;
    fetches: readonly { endpoint: string; httpStatus: number | null; contentType: string | null; bytesReceived: number; latencyMs: number; outcome: 'completed' | 'failed'; }[];
    historical: null | {
      eventDate: string; status: 'reconstructed' | 'insufficient';
      blocks: readonly {
        id: string; title: string; status: 'selected' | 'not_yet_published' | 'not_effective_yet' | 'insufficient';
        reason?: string; consideredVersionCount: number; publicationDate?: string; effectiveDate?: string | null;
        modifyingNormId?: string; publicationUrl?: string; text?: string; textTruncated?: boolean; notes?: readonly string[];
      }[];
      limitations: readonly string[];
    };
    temporal: null | {
      assessment: 'consolidation_pending_update' | 'annulled_by_reference_date' | 'annulment_after_reference_date' |
        'repealed_by_reference_date' | 'derogation_after_reference_date' | 'not_effective_yet' |
        'exhausted_date_unknown' | 'not_marked_derogated_or_exhausted' | 'insufficient';
      referenceDate: string;
      publicationDate: string | null;
      effectiveDate: string | null;
      derogationDate: string | null;
      annulmentDate: string | null;
      lastRegistryUpdate: string | null;
      derogated: boolean | null;
      annulled: boolean | null;
      exhausted: boolean | null;
      consolidationStatus: string | null;
      relatedNorms: readonly string[];
    };
    limitations: readonly string[];
  };
}
interface ClaimSourceReference {
  id: string; title: string; url: string; domain: string;
  sourceKind: SearchSource['sourceKind']; sourceAuthority: SearchSource['sourceAuthority'];
  evidenceClass: 'official_publication' | 'informative_consolidation' | 'dgt_doctrine' | 'teac_criteria' | 'administrative_guidance' | 'administrative_information' | 'official_information' | 'legislation_source_unclassified' | 'external';
  publishedAt: string | null; modifiedAt: string | null;
  documentStatus: 'retrieved' | 'partial' | 'unavailable' | 'unsupported' | null;
  documentType: 'boe_consolidated_legislation' | 'official_html' | 'unsupported_format' | null;
  temporalAssessment: NonNullable<NonNullable<SearchSource['document']>['temporal']>['assessment'] | null;
  evidenceStatus: 'excerpt_matched' | 'excerpt_not_found' | 'document_not_retrieved' | 'quote_not_provided';
  quote: string | null; locator: string | null; locatorVerified: boolean;
}
interface ModelReportedConflict {
  status: 'reported_with_fragments' | 'unverified';
  sourceIds: readonly [string, string]; reason: string;
}
interface MaterialClaim {
  id: string; text: string;
  classification: 'documented_fact' | 'interpretation' | 'case_dependent' | 'unclassified';
  kind: 'evidence_located' | 'unresolved';
  primaryPublication: { status: 'cited_with_excerpt' | 'cited_without_excerpt' | 'available_not_cited' | 'not_located_in_results' | 'not_required'; sourceIds: readonly string[] };
  sourceRefs: readonly ClaimSourceReference[]; unresolvedReferences: readonly string[];
  conflicts: readonly ModelReportedConflict[]; reviewRequired: true;
}
interface ResearchResponse {
  data?: { answer: string; claimEvidence: { claims: readonly MaterialClaim[]; limitations: readonly string[] }; provider: string; searchedAt: string; mode: 'general' | 'tax'; taxContext?: {
    jurisdiction: string; autonomousCommunity?: string | null; municipality?: string | null;
    taxpayerType?: 'individual' | 'self_employed' | 'company' | 'other' | null;
    eventDate?: string | null; matter: string; taxYear: string; filingYear: string; referenceDate: string;
  }; sources: readonly SearchSource[]; sourceCount: number; };
  error?: { code?: string; message?: string };
}
function today(): string {
  const value = new Date();
  return [String(value.getFullYear()).padStart(4, '0'), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
}
async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || 'La búsqueda web no está disponible.');
  return payload;
}
function sourceAuthorityLabel(authority: SearchSource['sourceAuthority']): string {
  const labels: Record<SearchSource['sourceAuthority'], string> = {
    legislation: 'Publicación normativa',
    legal_consolidation: 'Base de legislación consolidada (informativa)',
    dgt_criteria: 'Doctrina DGT',
    teac_criteria: 'Criterio / resolución TEAC',
    tax_administration: 'Ministerio de Hacienda',
    tax_agency_guidance: 'Información AEAT',
    official_information: 'Organismo oficial',
    external: 'Fuente externa',
  };
  return labels[authority];
}
function claimClassificationLabel(value: MaterialClaim['classification']): string {
  return ({
    documented_fact: 'Hecho presentado como documentado',
    interpretation: 'Interpretación del modelo',
    case_dependent: 'Depende de circunstancias del supuesto',
    unclassified: 'Sin clasificar',
  } as const)[value];
}
function evidenceClassLabel(value: ClaimSourceReference['evidenceClass']): string {
  return ({
    official_publication: 'Publicación oficial original',
    informative_consolidation: 'Consolidación informativa',
    dgt_doctrine: 'Doctrina DGT',
    teac_criteria: 'Criterio / resolución TEAC',
    administrative_guidance: 'Guía administrativa',
    administrative_information: 'Información de la Administración',
    official_information: 'Información de organismo oficial',
    legislation_source_unclassified: 'Fuente en portal normativo; documento no clasificado',
    external: 'Fuente secundaria o externa',
  } as const)[value];
}
function claimDocumentStatusLabel(value: ClaimSourceReference['documentStatus']): string {
  if (value === 'retrieved') return 'Documento recuperado';
  if (value === 'partial') return 'Documento recuperado parcialmente';
  if (value === 'unsupported') return 'Formato no compatible';
  return 'Documento no recuperado';
}
function primaryPublicationStatusLabel(value: MaterialClaim['primaryPublication']['status']): string {
  return ({
    cited_with_excerpt: 'Publicación primaria citada con fragmento localizado',
    cited_without_excerpt: 'Publicación primaria citada, pero sin fragmento verificable',
    available_not_cited: 'Hay una publicación primaria entre los resultados, pero esta afirmación no la cita',
    not_located_in_results: 'No se localizó publicación primaria en los resultados devueltos; la búsqueda no es exhaustiva',
    not_required: 'No exigida para esta consulta',
  } as const)[value];
}
function documentStatusLabel(
  status: NonNullable<SearchSource['document']>['status'],
  authority: SearchSource['sourceAuthority'],
): string {
  if (status === 'retrieved' && authority === 'legal_consolidation') return 'Texto consolidado informativo recuperado';
  if (status === 'retrieved') return 'Texto oficial recuperado';
  if (status === 'partial') return 'Recuperación parcial';
  if (status === 'unsupported') return 'Formato no compatible';
  return 'Documento no recuperado';
}
function temporalAssessmentLabel(assessment: NonNullable<NonNullable<SearchSource['document']>['temporal']>['assessment']): string {
  const labels: Record<typeof assessment, string> = {
    consolidation_pending_update: 'Consolidación pendiente de actualización',
    annulled_by_reference_date: 'BOE marca anulación en/antes de la fecha de referencia',
    annulment_after_reference_date: 'BOE fecha la anulación después de la fecha de referencia',
    repealed_by_reference_date: 'BOE marca derogación en/antes de la fecha de referencia',
    derogation_after_reference_date: 'BOE fecha la derogación después de la fecha de referencia',
    not_effective_yet: 'Entrada en vigor posterior a la fecha de referencia',
    exhausted_date_unknown: 'Vigencia agotada; fecha no disponible',
    not_marked_derogated_or_exhausted: 'Sin marca BOE de derogación/anulación/agotamiento en la ficha consultada',
    insufficient: 'Metadatos temporales insuficientes',
  };
  return labels[assessment];
}
function sourceTypeLabel(kind: SearchSource['sourceKind']): string {
  if (kind === 'normativa') return 'Normativa publicada';
  if (kind === 'normativa_consolidada_informativa') return 'Legislación consolidada (informativa)';
  if (kind === 'criterio_administrativo') return 'Criterio administrativo';
  if (kind === 'organismo_oficial') return 'Organismo oficial';
  return 'Fuente externa';
}
function formatDate(value: string | null): string {
  if (!value) return 'Fecha no indicada por la fuente';
  return new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(value));
}

export function WebResearchPanel() {
  const [status, setStatus] = useState<SearchStatus | null>(null);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'general' | 'tax'>('general');
  const [consent, setConsent] = useState(false);
  const [domainsText, setDomainsText] = useState('');
  const [jurisdiction, setJurisdiction] = useState('');
  const [autonomousCommunity, setAutonomousCommunity] = useState('');
  const [municipality, setMunicipality] = useState('');
  const [taxpayerType, setTaxpayerType] = useState<'' | 'individual' | 'self_employed' | 'company' | 'other'>('');
  const [eventDate, setEventDate] = useState('');
  const [matter, setMatter] = useState('');
  const [taxYear, setTaxYear] = useState('');
  const [filingYear, setFilingYear] = useState('');
  const [referenceDate, setReferenceDate] = useState(today);
  const [result, setResult] = useState<ResearchResponse['data'] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/v1/assistant/web-search/status', { signal: controller.signal, headers: { Accept: 'application/json' } })
      .then(readJson<SearchStatus>).then(setStatus)
      .catch(() => { if (!controller.signal.aborted) setStatus({ enabled: false, provider: 'SearXNG', explicitConsentRequired: true, toolCallingRequired: true, maximumResults: 5 }); });
    return () => controller.abort();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !consent || query.trim().length < 2) return;
    setBusy(true); setError(''); setResult(null); setConsent(false);
    const domains = [...new Set(domainsText.split(',').map((domain) => domain.trim().toLowerCase()).filter(Boolean))];
    try {
      const response = await fetch('/api/v1/assistant/web-search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          consent: true,
          query: query.trim(),
          mode,
          domains,
          ...(mode === 'tax' ? {
            jurisdiction: jurisdiction.trim(),
            ...(autonomousCommunity.trim() ? { autonomousCommunity: autonomousCommunity.trim() } : {}),
            ...(municipality.trim() ? { municipality: municipality.trim() } : {}),
            ...(taxpayerType ? { taxpayerType } : {}),
            ...(eventDate ? { eventDate } : {}),
            matter: matter.trim(), taxYear, filingYear, referenceDate,
          } : {}),
        }),
      });
      const payload = await readJson<ResearchResponse>(response);
      if (!payload.data) throw new Error('La API no devolvió un resultado de investigación.');
      setResult(payload.data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No se pudo completar la búsqueda.');
    } finally { setBusy(false); }
  }

  const taxContextComplete = mode !== 'tax' ||
    (jurisdiction.trim().length > 0 && matter.trim().length > 0 && /^\d{4}$/.test(taxYear) &&
      /^\d{4}$/.test(filingYear) && /^\d{4}-\d{2}-\d{2}$/.test(referenceDate));
  const ready = status?.enabled === true;

  return (
    <section className="content-section" aria-labelledby="web-research-heading">
      <div className="section-heading">
        <div><p className="eyebrow">INVESTIGACIÓN EXTERNA · OPCIONAL</p><h2 id="web-research-heading">Buscar y contrastar fuentes</h2></div>
        <span className="date-badge">{ready ? 'SearXNG configurado' : status ? 'Desactivado' : 'Comprobando'}</span>
      </div>
      <article className="panel assistant-panel">
        <p>La búsqueda es independiente del análisis financiero. SearXNG recibe exclusivamente el texto exacto de la consulta que escribas. El contexto fiscal opcional se procesa con Ollama local y no se añade a la consulta externa. Para resultados oficiales admitidos, el servidor puede consultar hasta tres enlaces del organismo y recuperar su contenido en modo lectura; esos organismos reciben la petición desde la IP del servidor. Nunca se adjuntan cuentas, movimientos, saldos, importes, categorías, objetivos, compromisos ni el contexto del asistente financiero.</p>
        {!ready ? <p className="section-footnote">Para habilitarla, configura <code>WEB_SEARCH_ENABLED=true</code>, un SearXNG accesible y Ollama local. La búsqueda permanece desactivada por defecto.</p> : null}
        <form onSubmit={submit}>
          <label className="field-label">Tipo de investigación
            <select value={mode} onChange={(event) => { setMode(event.currentTarget.value as 'general' | 'tax'); setResult(null); setConsent(false); }}>
              <option value="general">General</option>
              <option value="tax">Fiscal y normativa</option>
            </select>
          </label>
          <label className="field-label">Consulta exacta que se enviará
            <textarea value={query} onChange={(event) => { setQuery(event.currentTarget.value); setConsent(false); }} maxLength={500} rows={3} required placeholder="Escribe solo los términos que quieres consultar en el buscador." />
          </label>
          {mode === 'tax' ? <div className="research-grid">
            <label className="field-label">Jurisdicción principal (no se infiere)<input value={jurisdiction} onChange={(event) => setJurisdiction(event.currentTarget.value)} maxLength={120} required placeholder="Ej. España" /></label>
            <label className="field-label">Comunidad autónoma (opcional)<input value={autonomousCommunity} onChange={(event) => setAutonomousCommunity(event.currentTarget.value)} maxLength={120} placeholder="Ej. Galicia, Madrid, Navarra" /></label>
            <label className="field-label">Municipio (opcional)<input value={municipality} onChange={(event) => setMunicipality(event.currentTarget.value)} maxLength={120} placeholder="Solo si afecta al tributo o trámite" /></label>
            <label className="field-label">Tipo de contribuyente (opcional)
              <select value={taxpayerType} onChange={(event) => setTaxpayerType(event.currentTarget.value as typeof taxpayerType)}>
                <option value="">No especificado</option>
                <option value="individual">Persona física</option>
                <option value="self_employed">Autónomo / actividad económica</option>
                <option value="company">Sociedad</option>
                <option value="other">Otro / no clasificado</option>
              </select>
            </label>
            <label className="field-label">Impuesto o trámite<input value={matter} onChange={(event) => setMatter(event.currentTarget.value)} maxLength={120} required placeholder="Ej. IRPF, IVA, modelo 100" /></label>
            <label className="field-label">Ejercicio fiscal<input value={taxYear} onChange={(event) => setTaxYear(event.currentTarget.value)} inputMode="numeric" pattern="[0-9]{4}" maxLength={4} required placeholder="AAAA" /></label>
            <label className="field-label">Año de presentación<input value={filingYear} onChange={(event) => setFilingYear(event.currentTarget.value)} inputMode="numeric" pattern="[0-9]{4}" maxLength={4} required placeholder="AAAA" /></label>
            <label className="field-label">Fecha de referencia para vigencia<input type="date" value={referenceDate} onChange={(event) => setReferenceDate(event.currentTarget.value)} required /></label>
            <label className="field-label">Fecha del hecho u operación (opcional)<input type="date" value={eventDate} onChange={(event) => setEventDate(event.currentTarget.value)} /></label>
          </div> : null}
          {mode === 'tax' ? <p className="section-footnote">Incluye en la consulta los términos de búsqueda que correspondan a la jurisdicción, materia y ejercicios indicados. Los campos fiscales aportan contexto únicamente a Ollama local; no se añaden a la búsqueda externa. La fecha del hecho describe la operación investigada; la fecha de referencia se utiliza para evaluar los metadatos temporales del BOE. No introduzcas NIF, nombres, datos de contacto ni otros identificadores personales.</p> : null}
          <label className="field-label">Dominios oficiales permitidos (separados por coma)
            <input value={domainsText} onChange={(event) => setDomainsText(event.currentTarget.value)} maxLength={1_000} placeholder="Dejar vacío para no filtrar por dominio en modo general." />
          </label>
          <p className="section-footnote">Filtros de dominio disponibles: {OFFICIAL_DOMAINS.join(', ')}. El filtro se aplica en el backend sobre los resultados recibidos: no modifica el texto que recibe SearXNG. En modo general, deja el campo vacío para no filtrar; en modo fiscal, vacío equivale a todos los filtros oficiales. Aunque el filtro agrupe subdominios de una institución, la clasificación y recuperación de documentos solo aceptan hosts explícitamente aprobados. SearXNG puede remitir la consulta a motores upstream; estos ven la IP pública de salida de SearXNG.</p>
          <label className="field-label inline-field">
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.currentTarget.checked)} />
            Autorizo enviar esta consulta a SearXNG y permitir la recuperación de documentos oficiales enlazados por el servidor.
          </label>
          <button className="button primary" type="submit" disabled={!ready || !consent || !taxContextComplete || busy || query.trim().length < 2}>
            {busy ? 'Buscando y contrastando…' : 'Buscar y sintetizar fuentes'}
          </button>
        </form>
        {error ? <p className="form-alert error" role="alert">{error}</p> : null}
      </article>
      {result ? <>
        <article className="panel">
          <div className="section-heading"><div><h3>Resultado de investigación</h3><p className="section-footnote">Proveedor: {result.provider} · Búsqueda: {formatDate(result.searchedAt)}</p></div><span className="date-badge">{result.sourceCount} fuentes</span></div>
          {result.taxContext ? <p className="section-footnote">Jurisdicción: {result.taxContext.jurisdiction}{result.taxContext.autonomousCommunity ? ' · Comunidad: ' + result.taxContext.autonomousCommunity : ''}{result.taxContext.municipality ? ' · Municipio: ' + result.taxContext.municipality : ''}{result.taxContext.taxpayerType ? ' · Tipo: ' + ({ individual: 'Persona física', self_employed: 'Autónomo / actividad económica', company: 'Sociedad', other: 'Otro' } as const)[result.taxContext.taxpayerType] : ''} · Materia: {result.taxContext.matter} · Ejercicio: {result.taxContext.taxYear} · Presentación: {result.taxContext.filingYear} · Fecha de referencia: {result.taxContext.referenceDate}{result.taxContext.eventDate ? ' · Fecha del hecho: ' + result.taxContext.eventDate : ''}</p> : null}
          <p className="research-answer">{result.answer}</p>
          {result.claimEvidence.claims.length > 0 ? <section className="claim-evidence" aria-labelledby="claim-evidence-heading">
            <h4 id="claim-evidence-heading">Afirmaciones y referencias asociadas</h4>
            <p className="section-footnote">La API comprueba que el fragmento citado aparece literalmente en el extracto recuperado. Esto no demuestra que la fuente implique la afirmación ni valida su fuerza jurídica, vigencia o aplicación al supuesto.</p>
            <ol className="source-list">
              {result.claimEvidence.claims.map((claim) => <li key={claim.id}>
                <p>{claim.text}</p>
                <p className="section-footnote">Clasificación propuesta por el modelo: {claimClassificationLabel(claim.classification)} · No equivale a validación jurídica.</p>
                <p className="section-footnote">Comprobación documental: {claim.kind === 'evidence_located' ? 'fragmentos literales localizados' : 'evidencia documental insuficiente'} · Revisión humana requerida</p>
                {claim.primaryPublication.status !== 'not_required' ? <>
                  <p className="section-footnote">Publicación primaria: {primaryPublicationStatusLabel(claim.primaryPublication.status)}.</p>
                  {claim.primaryPublication.sourceIds.length > 0 ? <ul aria-label="Publicaciones oficiales primarias relacionadas">
                    {claim.primaryPublication.sourceIds.map((sourceId) => {
                      const primary = result.sources.find((candidate) => candidate.id === sourceId);
                      return primary ? <li key={sourceId}><a href={primary.url} target="_blank" rel="noopener noreferrer">[{primary.id}] {primary.title}</a></li> : null;
                    })}
                  </ul> : null}
                </> : null}
                {claim.sourceRefs.length > 0 ? <ul>
                  {claim.sourceRefs.map((source) => <li key={source.id}>
                    <div><a href={source.url} target="_blank" rel="noopener noreferrer">[{source.id}] {source.title} · {source.domain} · {sourceAuthorityLabel(source.sourceAuthority)}</a></div>
                    <p className="section-footnote">Naturaleza declarada de la fuente: {evidenceClassLabel(source.evidenceClass)}.</p>
                    <p className="section-footnote">Recuperación documental: {claimDocumentStatusLabel(source.documentStatus)} · {source.documentType === 'boe_consolidated_legislation' ? 'consolidación BOE informativa' : source.documentType === 'official_html' ? 'HTML oficial' : source.documentType === 'unsupported_format' ? 'formato no compatible' : 'tipo documental no indicado'}.</p>
                    <p className="section-footnote">Fechas del buscador (no equivalen a vigencia): publicación {formatDate(source.publishedAt)}{source.modifiedAt ? ' · modificación indicada: ' + formatDate(source.modifiedAt) : ''}.</p>
                    {source.temporalAssessment ? <p className="section-footnote">Metadatos temporales BOE: {temporalAssessmentLabel(source.temporalAssessment)}.</p> : null}
                    <p className="section-footnote">Comprobación: {source.evidenceStatus === 'excerpt_matched' ? 'el fragmento aparece en el documento recuperado' : source.evidenceStatus === 'excerpt_not_found' ? 'el fragmento no aparece en el extracto recuperado' : source.evidenceStatus === 'document_not_retrieved' ? 'no se recuperó el documento para contrastarlo' : 'no se proporcionó un fragmento literal'}</p>
                    {source.quote ? <blockquote className="research-answer">{source.quote}</blockquote> : null}
                    {source.locator ? <p className="section-footnote">Localizador: {source.locator} · {source.locatorVerified ? 'comprobado en el texto' : 'propuesto, no verificado'}</p> : null}
                  </li>)}
                </ul> : <p className="section-footnote">No hay una fuente válida asociada a esta afirmación.</p>}
                {claim.unresolvedReferences.length > 0 ? <p className="section-footnote">Referencias no resueltas: {claim.unresolvedReferences.join(', ')}</p> : null}
                {claim.conflicts.map((conflict, index) => <p className="section-footnote" key={index}>Posible discrepancia señalada por el modelo entre {conflict.sourceIds.join(' y ')}: {conflict.reason} · {conflict.status === 'reported_with_fragments' ? 'ambos fragmentos están localizados, pendiente de valoración' : 'no hay evidencia suficiente para contrastar ambos fragmentos'}</p>)}
              </li>)}
            </ol>
            {result.claimEvidence.limitations.map((limitation, index) => <p className="section-footnote" key={index}>{limitation}</p>)}
          </section> : null}
          <p className="section-footnote">La síntesis es una ayuda de investigación generada por el modelo local. Los resultados externos no son instrucciones ni constituyen evidencia jurídica por sí solos. Comprueba el texto oficial y su vigencia antes de actuar.</p>
        </article>
        <article className="panel">
          <h3>Fuentes encontradas</h3>
          {result.sources.length === 0 ? <p>No se encontraron fuentes que cumplan los filtros de dominio seleccionados.</p> :
            <ol className="source-list">{result.sources.map((source) => <li key={source.id}>
              <div><strong>{source.id} · {source.title}</strong><span className="date-badge">{sourceTypeLabel(source.sourceKind)}</span></div>
              <p className="section-footnote">{source.institution} · {source.domain} · Publicación: {formatDate(source.publishedAt)}{source.modifiedAt ? ' · Modificación: ' + formatDate(source.modifiedAt) : ''}</p>
              <p className="section-footnote">Clasificación de autoridad: {sourceAuthorityLabel(source.sourceAuthority)}</p>
              <p>{source.snippet}</p>
              {source.document ? <div className="source-document-evidence">
                <p className="section-footnote"><strong>{documentStatusLabel(source.document.status, source.sourceAuthority)}</strong>
                  {source.document.retrievedAt ? ' · Recuperado: ' + formatDate(source.document.retrievedAt) : ''}
                  {source.document.textLength > 0 ? ' · Texto de origen: ' + source.document.textLength.toLocaleString('es-ES') + ' caracteres' : ''}
                </p>
                {source.document.fetches.length > 0 ? <ul className="section-footnote" aria-label="Peticiones documentales realizadas por el backend">
                  {source.document.fetches.map((fetch, index) => <li key={index}>
                    {fetch.endpoint} · HTTP {fetch.httpStatus ?? 'sin respuesta'} · {fetch.contentType ?? 'MIME no disponible'} · {fetch.bytesReceived.toLocaleString('es-ES')} bytes · {fetch.latencyMs} ms
                  </li>)}
                </ul> : null}
                {source.document.historical ? <section className="source-document-evidence" aria-label="Historial de versiones BOE por artículo">
                  <p className="section-footnote"><strong>Historial BOE para el hecho de {source.document.historical.eventDate}: {source.document.historical.status === 'reconstructed' ? 'versión localizada' : 'evidencia insuficiente'}</strong></p>
                  {source.document.historical.blocks.map((block) => <article key={block.id}>
                    <p className="section-footnote"><strong>{block.title}</strong> · {block.status === 'selected' ? 'Versión seleccionada por fecha de vigencia' : block.status === 'not_yet_published' ? 'Norma modificadora aún no publicada en esa fecha' : block.status === 'not_effective_yet' ? 'Versión publicada pero aún no vigente' : 'No se puede determinar la versión aplicable'}</p>
                    {block.publicationDate ? <p className="section-footnote">Publicación de la norma modificadora: {formatDate(block.publicationDate)}{block.effectiveDate ? ' · Entrada en vigor de esta versión: ' + formatDate(block.effectiveDate) : ' · Fecha de entrada en vigor no acreditada'}</p> : null}
                    {block.modifyingNormId && block.publicationUrl ? <p className="section-footnote"><a href={block.publicationUrl} target="_blank" rel="noopener noreferrer">Publicación BOE {block.modifyingNormId}</a></p> : null}
                    {block.text ? <><p className="section-footnote">{block.textTruncated ? 'Extracto limitado a 6.000 caracteres; consulta la publicación BOE enlazada para el texto íntegro.' : 'Texto recuperado del bloque consolidado informativo.'}</p><blockquote className="research-answer">{block.text}</blockquote></> : null}
                    {block.notes?.map((note, index) => <p className="section-footnote" key={index}>Nota BOE: {note}</p>)}
                    {block.reason ? <p className="section-footnote">Motivo: {block.reason === 'possible_retroactivity' ? 'Existe una versión publicada después del hecho cuya fecha de vigencia es anterior o no está acreditada; se requiere revisión jurídica.' : block.reason === 'effective_before_publication' ? 'La versión declara una fecha de vigencia anterior a su publicación; no se infiere la aplicación retroactiva.' : block.reason}</p> : null}
                  </article>)}
                  {source.document.historical.limitations.map((limitation, index) => <p className="section-footnote" key={index}>{limitation}</p>)}
                </section> : null}
                {source.document.temporal ? <p className="section-footnote">
                  Estado temporal BOE a {source.document.temporal.referenceDate}: <strong>{temporalAssessmentLabel(source.document.temporal.assessment)}</strong>
                  {source.document.temporal.publicationDate ? ' · Publicación: ' + source.document.temporal.publicationDate : ''}
                  {source.document.temporal.effectiveDate ? ' · Entrada en vigor: ' + source.document.temporal.effectiveDate : ''}
                  {source.document.temporal.derogationDate ? ' · Derogación: ' + source.document.temporal.derogationDate : ''}
                  {source.document.temporal.annulmentDate ? ' · Anulación: ' + source.document.temporal.annulmentDate : ''}
                  {source.document.temporal.lastRegistryUpdate ? ' · Actualización de ficha: ' + source.document.temporal.lastRegistryUpdate : ''}
                </p> : null}
                {source.document.excerpt ? <blockquote className="research-answer">{source.document.excerpt}</blockquote> : null}
                {source.document.temporal?.relatedNorms.length ? <p className="section-footnote">Relaciones normativas declaradas por BOE: {source.document.temporal.relatedNorms.join('; ')}</p> : null}
                {source.document.limitations.map((limitation, index) => <p className="section-footnote" key={index}>{limitation}</p>)}
              </div> : source.sourceAuthority !== 'external' ? <p className="section-footnote">No se pudo recuperar el documento original de esta fuente; el resultado sigue siendo un fragmento de búsqueda y no acredita vigencia.</p> : null}
              <a href={source.url} target="_blank" rel="noopener noreferrer">{source.url}</a>
            </li>)}</ol>}
        </article>
      </> : null}
    </section>
  );
}
