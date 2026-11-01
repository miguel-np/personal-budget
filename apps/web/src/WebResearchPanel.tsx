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
  'xunta.gal',
  'dog.gal',
  'cnmv.es',
  'bde.es',
] as const;

interface SearchStatus { enabled: boolean; provider: string; explicitConsentRequired: boolean; toolCallingRequired: boolean; maximumResults: number; }
interface SearchSource {
  id: string; title: string; url: string; domain: string; institution: string; publishedAt: string | null; modifiedAt: string | null;
  snippet: string;
  sourceKind: 'normativa' | 'criterio_administrativo' | 'organismo_oficial' | 'externa';
  sourceAuthority: 'legislation' | 'dgt_criteria' | 'teac_criteria' | 'tax_administration' | 'tax_agency_guidance' | 'official_information' | 'external';
  document?: {
    status: 'retrieved' | 'partial' | 'unavailable' | 'unsupported';
    documentType: 'boe_consolidated_legislation' | 'official_html' | 'unsupported_format';
    retrievedAt: string | null;
    contentType: string | null;
    excerpt: string;
    textLength: number;
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
interface ResearchResponse {
  data?: { answer: string; provider: string; searchedAt: string; mode: 'general' | 'tax'; taxContext?: {
    jurisdiction: string; matter: string; taxYear: string; filingYear: string; referenceDate: string;
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
    dgt_criteria: 'Doctrina DGT',
    teac_criteria: 'Criterio / resolución TEAC',
    tax_administration: 'Ministerio de Hacienda',
    tax_agency_guidance: 'Información AEAT',
    official_information: 'Organismo oficial',
    external: 'Fuente externa',
  };
  return labels[authority];
}
function documentStatusLabel(status: NonNullable<SearchSource['document']>['status']): string {
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
          ...(mode === 'tax' ? { jurisdiction, matter, taxYear, filingYear, referenceDate } : {}),
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
        <p>La búsqueda es independiente del análisis financiero. SearXNG recibe exclusivamente el texto exacto de la consulta que escribas. Para resultados oficiales admitidos, el servidor puede consultar hasta tres enlaces del organismo y recuperar su contenido en modo lectura; esos organismos reciben la petición desde la IP del servidor. Nunca se adjuntan cuentas, movimientos, saldos, importes, categorías, objetivos, compromisos ni el contexto del asistente financiero.</p>
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
            <label className="field-label">Jurisdicción (no se infiere)<input value={jurisdiction} onChange={(event) => setJurisdiction(event.currentTarget.value)} maxLength={120} required placeholder="Ej. España, Galicia" /></label>
            <label className="field-label">Impuesto o trámite<input value={matter} onChange={(event) => setMatter(event.currentTarget.value)} maxLength={120} required placeholder="Ej. IRPF, IVA, modelo 100" /></label>
            <label className="field-label">Ejercicio fiscal<input value={taxYear} onChange={(event) => setTaxYear(event.currentTarget.value)} inputMode="numeric" pattern="[0-9]{4}" maxLength={4} required placeholder="AAAA" /></label>
            <label className="field-label">Año de presentación<input value={filingYear} onChange={(event) => setFilingYear(event.currentTarget.value)} inputMode="numeric" pattern="[0-9]{4}" maxLength={4} required placeholder="AAAA" /></label>
            <label className="field-label">Fecha de referencia / vigencia<input type="date" value={referenceDate} onChange={(event) => setReferenceDate(event.currentTarget.value)} required /></label>
          </div> : null}
          {mode === 'tax' ? <p className="section-footnote">Incluye en la consulta los términos de búsqueda que correspondan a la jurisdicción, materia y ejercicios indicados. Los campos fiscales aportan contexto a la síntesis, pero no se añaden automáticamente a la búsqueda externa.</p> : null}
          <label className="field-label">Dominios oficiales permitidos (separados por coma)
            <input value={domainsText} onChange={(event) => setDomainsText(event.currentTarget.value)} maxLength={1_000} placeholder="Dejar vacío para no filtrar por dominio en modo general." />
          </label>
          <p className="section-footnote">Dominios oficiales admitidos: {OFFICIAL_DOMAINS.join(', ')}. En modo general, deja el campo vacío para no filtrar por dominio. En modo fiscal, si lo dejas vacío, la búsqueda se limita a todos los dominios oficiales. El buscador SearXNG puede remitir la consulta a sus motores upstream según su configuración; la IP pública visible para esos motores será la del servidor SearXNG.</p>
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
          {result.taxContext ? <p className="section-footnote">Jurisdicción: {result.taxContext.jurisdiction} · Materia: {result.taxContext.matter} · Ejercicio: {result.taxContext.taxYear} · Presentación: {result.taxContext.filingYear} · Fecha de referencia: {result.taxContext.referenceDate}</p> : null}
          <p className="research-answer">{result.answer}</p>
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
                <p className="section-footnote"><strong>{documentStatusLabel(source.document.status)}</strong>
                  {source.document.retrievedAt ? ' · Recuperado: ' + formatDate(source.document.retrievedAt) : ''}
                  {source.document.textLength > 0 ? ' · Texto de origen: ' + source.document.textLength.toLocaleString('es-ES') + ' caracteres' : ''}
                </p>
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
