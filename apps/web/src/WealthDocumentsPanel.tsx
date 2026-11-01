import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { downloadTextFile, exportDateStamp } from './export-utils.js';

type WealthKind = 'cash_external' | 'investment_portfolio' | 'security' | 'crypto' | 'real_estate' | 'vehicle' | 'loan_receivable' | 'other_asset' | 'loan' | 'mortgage' | 'other_liability';
type Classification = 'asset' | 'liability';
interface Account {
  readonly id: string;
  readonly name: string;
  readonly closed: boolean;
  readonly offBudget: boolean;
  readonly classification?: Classification | null;
}
interface Valuation {
  readonly id: string;
  readonly valuedAt: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly source: 'manual' | 'statement' | 'document';
  readonly notes?: string;
  readonly quantity?: string;
  readonly unitPriceMinor?: number;
  readonly createdAt: string;
}
interface WealthAsset {
  readonly id: string;
  readonly name: string;
  readonly kind: WealthKind;
  readonly description?: string;
  readonly owner?: string;
  readonly currency: string;
  readonly acquiredAt?: string;
  readonly status: 'active' | 'archived';
  readonly includeInNetWorth: boolean;
  readonly actualAccountId?: string;
  readonly valuations: readonly Valuation[];
}
interface WealthData {
  readonly version: 1;
  readonly settings: { readonly staleAfterDays: number; readonly includeOffBudgetAccounts: boolean };
  readonly accountClassifications: readonly { readonly accountId: string; readonly classification: Classification; readonly updatedAt: string }[];
  readonly assets: readonly WealthAsset[];
}
interface WealthSummary {
  readonly asOfDate: string;
  readonly currency: string;
  readonly status: 'available' | 'incomplete';
  readonly netWorthMinor: number | null;
  readonly actual: { readonly netWorthMinor: number | null; readonly assetsMinor: number; readonly liabilitiesMinor: number; readonly accountCount: number };
  readonly external: { readonly netWorthMinor: number | null; readonly assetsMinor: number; readonly liabilitiesMinor: number; readonly itemCount: number };
  readonly liquidity: { readonly cashLikeExternalMinor: number };
  readonly coverage: { readonly includedActualAccounts: number; readonly unclassifiedAccountIds: readonly string[]; readonly unconvertibleAccountIds: readonly string[]; readonly staleAssetIds: readonly string[]; readonly missingValuationIds: readonly string[]; readonly excludedDuplicateOrOptOutIds: readonly string[] };
  readonly settings: WealthData['settings'];
  readonly warnings: readonly string[];
}
interface LocalDocument {
  readonly id: string;
  readonly fileName: string;
  readonly displayName: string;
  readonly mediaType: 'application/pdf' | 'image/jpeg' | 'image/png';
  readonly sizeBytes: number;
  readonly documentDate?: string;
  readonly issuer?: string;
  readonly amountMinor?: number;
  readonly currency?: string;
  readonly tags: readonly string[];
  readonly notes?: string;
  readonly fiscalYear?: number;
  readonly classification: 'invoice_received' | 'invoice_issued' | 'expense' | 'income' | 'asset' | 'contract' | 'receipt' | 'other';
  readonly reviewStatus: 'pending' | 'reviewed' | 'incomplete';
  readonly addedAt: string;
  readonly archivedAt?: string;
  readonly links: readonly { readonly transactionId: string; readonly accountId: string; readonly transactionDate: string }[];
}
interface ApiPayload<T> { readonly data?: T; readonly error?: { readonly message?: string }; }

const WEALTH_KINDS: readonly { value: WealthKind; label: string }[] = [
  { value: 'cash_external', label: 'Efectivo o depósito externo' },
  { value: 'investment_portfolio', label: 'Cartera de inversión' },
  { value: 'security', label: 'Acciones o valores' },
  { value: 'crypto', label: 'Criptoactivos' },
  { value: 'real_estate', label: 'Inmueble' },
  { value: 'vehicle', label: 'Vehículo' },
  { value: 'loan_receivable', label: 'Préstamo a cobrar' },
  { value: 'other_asset', label: 'Otro activo' },
  { value: 'loan', label: 'Préstamo pendiente' },
  { value: 'mortgage', label: 'Hipoteca' },
  { value: 'other_liability', label: 'Otro pasivo' },
];
const PORTABLE_DATASETS = [
  { id: 'planning', label: 'Objetivos y compromisos' },
  { id: 'preferences', label: 'Preferencias de la aplicación' },
  { id: 'financial-actions', label: 'Alertas, decisiones y escenarios' },
  { id: 'periodic-reviews', label: 'Revisiones financieras' },
  { id: 'wealth', label: 'Patrimonio y valoraciones externas' },
  { id: 'documents', label: 'Metadatos y vínculos de justificantes' },
  { id: 'budgets', label: 'Presupuestos mensuales de Actual' },
] as const;
type PortableDataset = typeof PORTABLE_DATASETS[number]['id'];

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({})) as ApiPayload<T>;
  if (!response.ok || payload.data === undefined) throw new Error(payload.error?.message ?? 'La API local no pudo completar la operación.');
  return payload.data;
}
function money(amountMinor: number | null, currency: string): string {
  if (amountMinor === null) return 'No disponible';
  try { return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(amountMinor / 100); }
  catch { return amountMinor.toLocaleString('es-ES') + ' unidades menores · ' + currency; }
}
function latest(asset: WealthAsset): Valuation | null {
  return [...asset.valuations].sort((a, b) => b.valuedAt.localeCompare(a.valuedAt) || b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}
function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? Math.ceil(bytes / 1024) + ' KiB' : (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
}

export function WealthDocumentsPanel({ accounts, currency }: { accounts: readonly Account[]; currency: string }) {
  const [wealth, setWealth] = useState<WealthData | null>(null);
  const [summary, setSummary] = useState<WealthSummary | null>(null);
  const [documents, setDocuments] = useState<readonly LocalDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [assetName, setAssetName] = useState('');
  const [assetKind, setAssetKind] = useState<WealthKind>('investment_portfolio');
  const [assetCurrency, setAssetCurrency] = useState(currency);
  const [assetAccount, setAssetAccount] = useState('');
  const [assetDescription, setAssetDescription] = useState('');
  const [valuationAmount, setValuationAmount] = useState('');
  const [valuationDate, setValuationDate] = useState(new Date().toISOString().slice(0, 10));
  const [selectedFiles, setSelectedFiles] = useState<FileList | null>(null);
  const [documentName, setDocumentName] = useState('');
  const [documentDate, setDocumentDate] = useState('');
  const [documentIssuer, setDocumentIssuer] = useState('');
  const [documentClass, setDocumentClass] = useState<LocalDocument['classification']>('receipt');
  const [linkDrafts, setLinkDrafts] = useState<Record<string, { transactionId: string; accountId: string; transactionDate: string }>>({});
  const [datasets, setDatasets] = useState<PortableDataset[]>(['planning', 'preferences', 'wealth']);
  const [budgetMonth, setBudgetMonth] = useState(new Date().toISOString().slice(0, 7));
  const [includeDocumentFiles, setIncludeDocumentFiles] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextWealth, nextDocuments] = await Promise.all([
        request<WealthData>('/api/v1/wealth'),
        request<LocalDocument[]>('/api/v1/documents?includeArchived=true'),
      ]);
      setWealth(nextWealth);
      setDocuments(nextDocuments);
      try { setSummary(await request<WealthSummary>('/api/v1/wealth/summary')); }
      catch { setSummary(null); }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No se pudieron cargar los datos patrimoniales y documentales.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const activeAssets = useMemo(() => (wealth?.assets ?? []).filter((asset) => includeArchived || asset.status === 'active'), [wealth, includeArchived]);
  const openAccounts = useMemo(() => accounts.filter((account) => !account.closed), [accounts]);
  const classifications = useMemo(() => new Map((wealth?.accountClassifications ?? []).map((entry) => [entry.accountId, entry.classification])), [wealth]);

  async function mutate<T>(url: string, method: string, body?: unknown): Promise<T> {
    return request<T>(url, {
      method,
      headers: { 'content-type': 'application/json', Accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function saveAsset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      await mutate('/api/v1/wealth/assets', 'POST', {
        name: assetName, kind: assetKind, currency: assetCurrency.toUpperCase(),
        ...(assetDescription.trim() ? { description: assetDescription.trim() } : {}),
        ...(assetAccount ? { actualAccountId: assetAccount, includeInNetWorth: false } : { includeInNetWorth: true }),
      });
      setAssetName(''); setAssetDescription(''); setAssetAccount('');
      setNotice('Elemento patrimonial guardado. Añade una valoración fechada para incorporarlo al patrimonio.');
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo guardar el elemento.'); }
    finally { setBusy(false); }
  }
  async function saveValuation(event: FormEvent<HTMLFormElement>, asset: WealthAsset) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      const parsed = Number(valuationAmount.replace(',', '.'));
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error('Introduce un importe no negativo.');
      const fraction = new Intl.NumberFormat('en-US', { style: 'currency', currency: asset.currency }).resolvedOptions().maximumFractionDigits;
      const amountMinor = Math.round(parsed * (10 ** fraction));
      if (!Number.isSafeInteger(amountMinor)) throw new Error('El importe supera el rango admitido.');
      await mutate('/api/v1/wealth/assets/' + asset.id + '/valuations', 'POST', {
        valuedAt: valuationDate, amountMinor, currency: asset.currency, source: 'manual',
      });
      setValuationAmount(''); setNotice('Snapshot de valoración añadido. El historial anterior se conserva.');
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo guardar la valoración.'); }
    finally { setBusy(false); }
  }
  async function classifyAccount(accountId: string, value: string) {
    setBusy(true); setError(''); setNotice('');
    try {
      await mutate('/api/v1/wealth/accounts/' + encodeURIComponent(accountId) + '/classification', 'PUT', { classification: value || null });
      setNotice('Clasificación patrimonial de la cuenta actualizada.');
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo clasificar la cuenta.'); }
    finally { setBusy(false); }
  }
  async function saveSettings(staleAfterDays: number, includeOffBudgetAccounts: boolean) {
    if (!wealth) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await mutate('/api/v1/wealth/settings', 'PUT', { staleAfterDays, includeOffBudgetAccounts });
      setNotice('Reglas de vigencia y ámbito patrimonial guardadas.');
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo guardar la configuración.'); }
    finally { setBusy(false); }
  }
  async function archiveAsset(asset: WealthAsset) {
    const archived = asset.status === 'active';
    if (!window.confirm((archived ? '¿Archivar «' : '¿Reactivar «') + asset.name + '»?')) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await mutate('/api/v1/wealth/assets/' + asset.id + '/status', 'PATCH', { status: archived ? 'archived' : 'active' });
      setNotice(archived ? 'Elemento archivado; conserva sus valoraciones.' : 'Elemento reactivado.');
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo cambiar el estado.'); }
    finally { setBusy(false); }
  }
  async function removeAsset(asset: WealthAsset) {
    if (!window.confirm('Eliminar «' + asset.name + '» y todo su historial de valoraciones. Esta acción no se puede deshacer.')) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await mutate('/api/v1/wealth/assets/' + asset.id, 'DELETE', { confirm: true });
      setNotice('Elemento y su historial eliminados.');
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo eliminar el elemento.'); }
    finally { setBusy(false); }
  }
  async function uploadDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      const file = selectedFiles?.[0];
      if (!file) throw new Error('Selecciona un archivo PDF, JPEG o PNG.');
      if (file.size > 10 * 1024 * 1024) throw new Error('El archivo supera el límite de 10 MiB.');
      const metadata = {
        displayName: documentName.trim() || file.name,
        ...(documentDate ? { documentDate } : {}),
        ...(documentIssuer.trim() ? { issuer: documentIssuer.trim() } : {}),
        classification: documentClass, reviewStatus: 'pending',
      };
      await request<LocalDocument>('/api/v1/documents', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-document-metadata': JSON.stringify(metadata), Accept: 'application/json' },
        body: file,
      });
      setSelectedFiles(null); setDocumentName(''); setDocumentDate(''); setDocumentIssuer('');
      const input = document.querySelector<HTMLInputElement>('#local-document-file');
      if (input) input.value = '';
      setNotice('Justificante guardado localmente y verificado por su firma binaria.');
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo guardar el justificante.'); }
    finally { setBusy(false); }
  }
  async function updateDocument(documentItem: LocalDocument, patch: Record<string, unknown>) {
    setBusy(true); setError(''); setNotice('');
    try {
      await mutate('/api/v1/documents/' + documentItem.id, 'PATCH', patch);
      setNotice('Metadatos del justificante actualizados.');
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo actualizar el justificante.'); }
    finally { setBusy(false); }
  }
  async function updateLinks(documentItem: LocalDocument) {
    const draft = linkDrafts[documentItem.id];
    if (!draft?.transactionId || !draft.accountId || !draft.transactionDate) {
      setError('Completa el identificador, la cuenta y la fecha del movimiento.'); return;
    }
    setBusy(true); setError(''); setNotice('');
    try {
      await mutate('/api/v1/documents/' + documentItem.id + '/links', 'PUT', [...documentItem.links, draft]);
      setLinkDrafts((current) => ({ ...current, [documentItem.id]: { transactionId: '', accountId: '', transactionDate: '' } }));
      setNotice('Vínculo guardado después de verificar que el movimiento existe en Actual.');
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo vincular el movimiento.'); }
    finally { setBusy(false); }
  }
  async function archiveDocument(documentItem: LocalDocument) {
    const archived = !documentItem.archivedAt;
    if (!window.confirm((archived ? '¿Archivar «' : '¿Reactivar «') + documentItem.displayName + '»?')) return;
    await updateDocumentArchive(documentItem, archived);
  }
  async function updateDocumentArchive(documentItem: LocalDocument, archived: boolean) {
    setBusy(true); setError(''); setNotice('');
    try {
      await mutate('/api/v1/documents/' + documentItem.id + '/archive', 'PATCH', { archived });
      setNotice(archived ? 'Justificante archivado.' : 'Justificante reactivado.');
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo archivar el justificante.'); }
    finally { setBusy(false); }
  }
  async function removeDocument(documentItem: LocalDocument) {
    if (!window.confirm('Eliminar permanentemente el archivo «' + documentItem.displayName + '» y sus vínculos. Esta acción no se puede deshacer.')) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await mutate('/api/v1/documents/' + documentItem.id, 'DELETE', { confirm: true });
      setNotice('Archivo local y metadatos eliminados.');
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo eliminar el justificante.'); }
    finally { setBusy(false); }
  }
  async function exportPortable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      if (datasets.length === 0) throw new Error('Selecciona al menos un conjunto de datos.');
      const query = new URLSearchParams({ datasets: datasets.join(','), includeDocumentFiles: includeDocumentFiles ? 'true' : 'false', ...(datasets.includes('budgets') ? { budgetMonths: budgetMonth } : {}) });
      const response = await fetch('/api/v1/portable-export?' + query.toString(), { headers: { Accept: 'application/json' } });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as ApiPayload<unknown>;
        throw new Error(payload.error?.message ?? 'No se pudo crear la exportación portable.');
      }
      const text = JSON.stringify(await response.json(), null, 2) + '\n';
      downloadTextFile('personal-budget-portable-' + exportDateStamp() + '.json', text, 'application/json;charset=utf-8');
      setNotice('Exportación portable generada en este navegador. No sustituye al backup cifrado.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo exportar el estado local.'); }
    finally { setBusy(false); }
  }
  const selectedDocumentCount = documents.filter((item) => includeArchived || !item.archivedAt).length;

  return (
    <section className="content-section wealth-documents" aria-labelledby="wealth-documents-heading">
      <div className="section-heading">
        <div><p className="eyebrow">GESTIÓN PATRIMONIAL · PORTABILIDAD LOCAL</p><h2 id="wealth-documents-heading">Patrimonio y justificantes</h2></div>
        <span className="date-badge">{selectedDocumentCount} justificantes</span>
      </div>
      <p className="section-context">Actual Budget sigue siendo la fuente de verdad de cuentas y movimientos. Esta sección añade valoraciones externas fechadas y documentos locales vinculados, sin crear movimientos ni sincronizar datos fuera del equipo.</p>
      {error ? <div className="notice notice-error" role="alert"><p>{error}</p><button type="button" className="button secondary" onClick={() => { void load(); }}>Reintentar</button></div> : null}
      {notice ? <div className="notice notice-success" role="status">{notice}</div> : null}
      {loading ? <div className="loading-state" role="status">Cargando patrimonio y justificantes locales…</div> : null}

      {!loading && summary ? (
        <article className="panel wealth-summary" aria-labelledby="wealth-summary-heading">
          <div className="panel-heading"><div><p className="eyebrow">PATRIMONIO CONSOLIDADO · {summary.asOfDate}</p><h3 id="wealth-summary-heading">Patrimonio neto en {summary.currency}</h3></div><span className="status-chip">{summary.status === 'available' ? 'Cobertura completa' : 'Cobertura incompleta'}</span></div>
          <strong className="wealth-net-worth">{money(summary.netWorthMinor, summary.currency)}</strong>
          <div className="stats-grid wealth-breakdown">
            <article className="stat-card"><p>Actual Budget</p><strong>{money(summary.actual.netWorthMinor, summary.currency)}</strong><span>{summary.actual.accountCount} cuentas consideradas</span></article>
            <article className="stat-card"><p>Activos externos</p><strong>{money(summary.external.assetsMinor, summary.currency)}</strong><span>Valoraciones recientes convertibles</span></article>
            <article className="stat-card"><p>Pasivos externos</p><strong>{money(summary.external.liabilitiesMinor, summary.currency)}</strong><span>Deudas y obligaciones manuales</span></article>
          </div>
          <p className="section-footnote">La liquidez se presenta separada del patrimonio: efectivo externo identificado {money(summary.liquidity.cashLikeExternalMinor, summary.currency)}. No se considera dinero disponible para gastar ni se infiere rentabilidad.</p>
          {summary.warnings.length ? <ul className="warning-list">{summary.warnings.map((item) => <li key={item}>{item}</li>)}</ul> : null}
        </article>
      ) : !loading ? <article className="panel"><h3>Patrimonio consolidado no disponible</h3><p>El resumen requiere saldos de Actual y clasificación explícita de activo/pasivo, además de valoraciones externas vigentes y convertibles. El registro externo y los justificantes siguen disponibles.</p></article> : null}

      {wealth ? (
        <>
          <article className="panel wealth-settings">
            <div className="panel-heading"><div><p className="eyebrow">CALIDAD Y COBERTURA</p><h3>Clasificación y vigencia</h3></div></div>
            <p>Clasifica cada cuenta de Actual explícitamente. No se deduce la naturaleza patrimonial por el nombre ni por el signo del saldo.</p>
            <div className="wealth-account-classifications">
              {openAccounts.map((account) => (
                <label className="field-label" key={account.id}>{account.name}
                  <select disabled={busy} value={classifications.get(account.id) ?? ''} onChange={(event) => { void classifyAccount(account.id, event.currentTarget.value); }}>
                    <option value="">Sin clasificar</option><option value="asset">Activo</option><option value="liability">Pasivo</option>
                  </select>
                </label>
              ))}
              {!openAccounts.length ? <p className="muted-copy">No hay cuentas abiertas cargadas desde Actual.</p> : null}
            </div>
            <div className="form-grid">
              <label className="field-label">Antigüedad máxima de valoración (días)
                <input type="number" min={30} max={365} defaultValue={wealth.settings.staleAfterDays} key={'stale-' + wealth.settings.staleAfterDays} id="wealth-stale-days" />
              </label>
              <label className="check-field"><input type="checkbox" defaultChecked={wealth.settings.includeOffBudgetAccounts} key={'offbudget-' + wealth.settings.includeOffBudgetAccounts} id="wealth-offbudget" /> Incluir cuentas fuera de presupuesto</label>
            </div>
            <div className="button-row"><button className="button secondary" type="button" disabled={busy} onClick={() => {
              const stale = Number(document.querySelector<HTMLInputElement>('#wealth-stale-days')?.value ?? wealth.settings.staleAfterDays);
              const include = document.querySelector<HTMLInputElement>('#wealth-offbudget')?.checked ?? wealth.settings.includeOffBudgetAccounts;
              void saveSettings(stale, include);
            }}>Guardar cobertura</button></div>
          </article>

          <div className="wealth-management-grid">
            <article className="panel">
              <div className="panel-heading"><div><p className="eyebrow">REGISTRO MANUAL</p><h3>Añadir activo o pasivo externo</h3></div></div>
              <p>Registra solo elementos que no estén ya representados en una cuenta de Actual. Si vinculas una cuenta existente como referencia, se excluye automáticamente del cálculo para evitar duplicidades.</p>
              <form onSubmit={(event) => { void saveAsset(event); }}>
                <label className="field-label">Nombre<input required maxLength={120} value={assetName} onChange={(event) => setAssetName(event.currentTarget.value)} /></label>
                <label className="field-label">Tipo<select value={assetKind} onChange={(event) => setAssetKind(event.currentTarget.value as WealthKind)}>{WEALTH_KINDS.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}</select></label>
                <label className="field-label">Divisa<input required maxLength={3} minLength={3} pattern="[A-Za-z]{3}" value={assetCurrency} onChange={(event) => setAssetCurrency(event.currentTarget.value.toUpperCase())} /></label>
                <label className="field-label">Cuenta de Actual ya representada (opcional)<select value={assetAccount} onChange={(event) => setAssetAccount(event.currentTarget.value)}><option value="">No está representado en Actual</option>{openAccounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></label>
                <label className="field-label">Notas<input maxLength={2_000} value={assetDescription} onChange={(event) => setAssetDescription(event.currentTarget.value)} /></label>
                <button className="button primary" type="submit" disabled={busy}>Guardar elemento</button>
              </form>
            </article>
            <article className="panel">
              <div className="panel-heading"><div><p className="eyebrow">INVENTARIO PATRIMONIAL</p><h3>Activos y pasivos externos ({activeAssets.length})</h3></div><label className="check-field"><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.currentTarget.checked)} /> Mostrar archivados</label></div>
              {activeAssets.length ? <div className="wealth-asset-list">{activeAssets.map((asset) => {
                const valuation = latest(asset);
                const liability = ['loan', 'mortgage', 'other_liability'].includes(asset.kind);
                return <article className="wealth-asset-card" key={asset.id}>
                  <div className="wealth-asset-title"><div><span className="eyebrow">{liability ? 'PASIVO EXTERNO' : 'ACTIVO EXTERNO'} · {asset.status === 'active' ? 'ACTIVO' : 'ARCHIVADO'}</span><h4>{asset.name}</h4></div><strong>{valuation ? money(valuation.amountMinor, asset.currency) : 'Sin valoración'}</strong></div>
                  <p>{WEALTH_KINDS.find((kind) => kind.value === asset.kind)?.label} · {valuation ? 'Valorado el ' + valuation.valuedAt : 'Añade una valoración fechada'}{asset.actualAccountId ? ' · Referenciado en Actual (excluido del total)' : ''}</p>
                  {asset.description ? <p>{asset.description}</p> : null}
                  {asset.valuations.length > 1 ? <details><summary>Historial de {asset.valuations.length} valoraciones</summary><ul>{[...asset.valuations].sort((a,b)=>b.valuedAt.localeCompare(a.valuedAt)).map((item)=><li key={item.id}>{item.valuedAt} · {money(item.amountMinor,item.currency)} · {item.source}</li>)}</ul></details> : null}
                  {asset.status === 'active' && !asset.actualAccountId ? <form className="wealth-valuation-form" onSubmit={(event) => { void saveValuation(event, asset); }}>
                    <label className="field-label">Nueva valoración ({asset.currency})<input required inputMode="decimal" value={valuationAmount} onChange={(event)=>setValuationAmount(event.currentTarget.value)} placeholder="0,00" /></label>
                    <label className="field-label">Fecha de valoración<input required type="date" max={new Date().toISOString().slice(0,10)} value={valuationDate} onChange={(event)=>setValuationDate(event.currentTarget.value)} /></label>
                    <button className="button secondary" type="submit" disabled={busy}>Añadir snapshot</button>
                  </form> : null}
                  <div className="button-row"><button className="button secondary" type="button" disabled={busy} onClick={()=>{void archiveAsset(asset);}}>{asset.status === 'active' ? 'Archivar' : 'Reactivar'}</button><button className="button danger" type="button" disabled={busy} onClick={()=>{void removeAsset(asset);}}>Eliminar historial</button></div>
                </article>;
              })}</div> : <p className="muted-copy">No hay elementos externos en esta vista. Las cuentas de Actual se gestionan y concilian en Cuentas.</p>}
            </article>
          </div>
        </>
      ) : null}

      <article className="panel local-documents">
        <div className="panel-heading"><div><p className="eyebrow">CUSTODIA DOCUMENTAL LOCAL</p><h3>Justificantes y contratos ({selectedDocumentCount})</h3></div></div>
        <p>Solo PDF, JPEG y PNG. Los archivos se guardan fuera del directorio público con nombres internos generados, permisos privados y verificación SHA-256. No hay OCR ni envío remoto.</p>
        <form onSubmit={(event)=>{void uploadDocument(event);}} className="document-upload-form">
          <label className="field-label">Archivo<input id="local-document-file" required type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" onChange={(event)=>setSelectedFiles(event.currentTarget.files)} /></label>
          <label className="field-label">Nombre visible<input maxLength={200} value={documentName} onChange={(event)=>setDocumentName(event.currentTarget.value)} placeholder="Nombre del justificante" /></label>
          <label className="field-label">Fecha del documento<input type="date" value={documentDate} onChange={(event)=>setDocumentDate(event.currentTarget.value)} /></label>
          <label className="field-label">Emisor<input maxLength={200} value={documentIssuer} onChange={(event)=>setDocumentIssuer(event.currentTarget.value)} /></label>
          <label className="field-label">Tipo<select value={documentClass} onChange={(event)=>setDocumentClass(event.currentTarget.value as LocalDocument['classification'])}>
            <option value="receipt">Recibo</option><option value="invoice_received">Factura recibida</option><option value="invoice_issued">Factura emitida</option><option value="expense">Gasto</option><option value="income">Ingreso</option><option value="asset">Activo</option><option value="contract">Contrato</option><option value="other">Otro</option>
          </select></label>
          <button className="button primary" type="submit" disabled={busy}>Guardar justificante</button>
        </form>
        <div className="document-list-controls"><label className="check-field"><input type="checkbox" checked={includeArchived} onChange={(event)=>setIncludeArchived(event.currentTarget.checked)} /> Mostrar archivados</label><span>{documents.filter((item)=>includeArchived || !item.archivedAt).length} documento(s)</span></div>
        <div className="local-document-list">
          {documents.filter((item)=>includeArchived || !item.archivedAt).map((item)=>(
            <article className="local-document-card" key={item.id}>
              <div className="wealth-asset-title"><div><h4>{item.displayName}</h4><p>{item.mediaType} · {formatSize(item.sizeBytes)} · {item.documentDate ?? 'Fecha no indicada'} · {item.reviewStatus === 'reviewed' ? 'Revisado' : item.reviewStatus === 'incomplete' ? 'Incompleto' : 'Pendiente de revisar'}</p></div><a className="button secondary" href={'/api/v1/documents/' + item.id + '/file'}>Descargar</a></div>
              {item.issuer ? <p>Emisor: {item.issuer}</p> : null}
              {item.links.length ? <p>{item.links.length} movimiento(s) vinculado(s): {item.links.map((link)=>link.transactionDate + ' · ' + link.accountId + ' · ' + link.transactionId).join('; ')}</p> : <p className="muted-copy">Sin movimientos vinculados.</p>}
              <div className="form-grid document-link-form">
                <label className="field-label">ID del movimiento<input value={linkDrafts[item.id]?.transactionId ?? ''} onChange={(event)=>setLinkDrafts((old)=>({...old,[item.id]:{transactionId:event.currentTarget.value,accountId:old[item.id]?.accountId??'',transactionDate:old[item.id]?.transactionDate??''}}))} /></label>
                <label className="field-label">Cuenta<select value={linkDrafts[item.id]?.accountId ?? ''} onChange={(event)=>setLinkDrafts((old)=>({...old,[item.id]:{transactionId:old[item.id]?.transactionId??'',accountId:event.currentTarget.value,transactionDate:old[item.id]?.transactionDate??''}}))}><option value="">Selecciona cuenta</option>{openAccounts.map((account)=><option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
                <label className="field-label">Fecha<input type="date" value={linkDrafts[item.id]?.transactionDate ?? ''} onChange={(event)=>setLinkDrafts((old)=>({...old,[item.id]:{transactionId:old[item.id]?.transactionId??'',accountId:old[item.id]?.accountId??'',transactionDate:event.currentTarget.value}}))} /></label>
              </div>
              <div className="button-row">
                <button className="button secondary" type="button" disabled={busy} onClick={()=>{void updateLinks(item);}}>Vincular movimiento</button>
                <label className="field-label">Revisión<select disabled={busy} value={item.reviewStatus} onChange={(event)=>{void updateDocument(item,{reviewStatus:event.currentTarget.value});}}><option value="pending">Pendiente</option><option value="reviewed">Revisado</option><option value="incomplete">Incompleto</option></select></label>
                <button className="button secondary" type="button" disabled={busy} onClick={()=>{void archiveDocument(item);}}>{item.archivedAt?'Reactivar':'Archivar'}</button>
                <button className="button danger" type="button" disabled={busy} onClick={()=>{void removeDocument(item);}}>Eliminar</button>
              </div>
            </article>
          ))}
          {documents.filter((item)=>includeArchived || !item.archivedAt).length===0?<p className="muted-copy">No hay justificantes guardados.</p>:null}
        </div>
      </article>

      <article className="panel portable-export-panel">
        <div className="panel-heading"><div><p className="eyebrow">PORTABILIDAD HUMANA</p><h3>Exportar estado local</h3></div></div>
        <p>Genera un JSON versionado y legible con procedencia y recuentos. Los movimientos e informes de Actual conservan sus exportaciones CSV/JSON/XLSX actuales y no se duplican aquí.</p>
        <form onSubmit={(event)=>{void exportPortable(event);}}>
          <div className="portable-dataset-list">{PORTABLE_DATASETS.map((dataset)=>(
            <label className="check-field" key={dataset.id}><input type="checkbox" checked={datasets.includes(dataset.id)} onChange={(event)=>setDatasets((current)=>event.currentTarget.checked?[...current,dataset.id]:current.filter((item)=>item!==dataset.id))} /> {dataset.label}</label>
          ))}</div>
          {datasets.includes('documents')?<label className="check-field"><input type="checkbox" checked={includeDocumentFiles} onChange={(event)=>setIncludeDocumentFiles(event.currentTarget.checked)} /> Incluir también el contenido binario de los justificantes seleccionados (máximo 20 MiB)</label>:null}
          {datasets.includes('budgets')?<label className="field-label">Mes presupuestario a incluir<input type="month" required value={budgetMonth} onChange={(event)=>setBudgetMonth(event.currentTarget.value)} /></label>:null}
          <button className="button primary" type="submit" disabled={busy || datasets.length===0}>Generar exportación portable JSON</button>
        </form>
        <p className="section-footnote">No contiene claves, contraseñas, variables de entorno ni rutas privadas. Este archivo no es restaurable: usa el backup cifrado para recuperación integral.</p>
      </article>
    </section>
  );
}
