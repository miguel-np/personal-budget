import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { formatCivilDate, formatMoney } from './finance-format.js';

type SortKey = 'date' | 'amount' | 'description';
interface MovementTransaction {
  id: string;
  account: string;
  date: string;
  amount: number;
  currencyCode?: string | null;
  currency_code?: string | null;
  displayCurrency?: string;
  displayAmountMinor?: number | null;
  category?: string | null;
  transfer_id?: string | null;
  payee_id?: string | null;
  payee_name?: string | null;
  imported_payee?: string | null;
  notes?: string | null;
  cleared?: boolean;
  is_parent?: boolean;
  is_child?: boolean;
  is_split_child?: boolean;
  parent_id?: string | null;
  parent_transaction_id?: string;
  is_split_editable?: boolean;
  subtransactions?: readonly MovementTransaction[];
}
interface MovementAccount { id: string; name: string; closed: boolean }
interface MovementCategory { id: string; name: string; isIncome: boolean }
interface MovementManagerProps {
  transactions: readonly MovementTransaction[];
  total: number;
  accounts: readonly MovementAccount[];
  categories: readonly MovementCategory[];
  currency: string;
  locale: 'es-ES' | 'en-GB';
  startDate: string;
  endDate: string;
  accountFilter: string;
  categoryFilter: string;
  searchText: string;
  uncategorizedOnly: boolean;
  sortKey: SortKey;
  sortAscending: boolean;
  filterKey: string;
  onSort: (key: SortKey) => void;
  onUpdated: (notice: string, refresh?: boolean) => void;
}
interface ApiResult<T> {
  data?: T;
  error?: { code?: string; message?: string };
  pagination?: { total: number; limit: number; offset: number };
}
interface EditDraft {
  date: string;
  amount: string;
  concept: string;
  categoryId: string;
  notes: string;
  cleared: boolean;
}
interface UpdateFields {
  date?: string;
  amount?: number;
  imported_payee?: string;
  category?: string | null;
  notes?: string;
  cleared?: boolean;
}

function transactionDescription(transaction: MovementTransaction): string {
  return transaction.imported_payee?.trim() || transaction.payee_name?.trim() || transaction.notes?.trim() || 'Movimiento sin concepto';
}
function canEdit(transaction: MovementTransaction): boolean {
  if (transaction.transfer_id) return true;
  if (transaction.is_split_child) return Boolean(transaction.is_split_editable && transaction.parent_transaction_id);
  return !transaction.is_parent && !transaction.is_child && !transaction.parent_id && !(transaction.subtransactions?.length);
}
function canBulkCategorize(transaction: MovementTransaction): boolean {
  return canEdit(transaction) && !transaction.transfer_id && !transaction.is_split_child && transaction.amount < 0;
}
function amountInput(amountMinor: number, locale: 'es-ES' | 'en-GB'): string {
  const value = Math.abs(amountMinor);
  const sign = amountMinor < 0 ? '-' : '';
  const separator = locale === 'es-ES' ? ',' : '.';
  return sign + Math.floor(value / 100).toString() + separator + String(value % 100).padStart(2, '0');
}
/** Ambiguous thousands separators are rejected; users can enter 1234,56 or 1234.56. */
function parseAmountInput(raw: string): number | null {
  const value = raw.trim();
  if (!/^[+-]?\d+(?:[.,]\d{1,2})?$/.test(value)) return null;
  const parsed = Number(value.replace(',', '.'));
  if (!Number.isFinite(parsed) || parsed === 0) return null;
  const minor = Math.round(parsed * 100);
  return Number.isSafeInteger(minor) && minor !== 0 ? minor : null;
}
function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [yearText, monthText, dayText] = value.split('-');
  const date = new Date(Number(yearText), Number(monthText) - 1, Number(dayText), 12);
  return date.getFullYear() === Number(yearText) && date.getMonth() === Number(monthText) - 1 && date.getDate() === Number(dayText);
}
function safeCsvCell(value: unknown, formulaSafe = false): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (formulaSafe && /^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
async function requestJson<T>(url: string, init?: RequestInit): Promise<{ response: Response; payload: ApiResult<T> }> {
  const response = await fetch(url, { ...init, headers: { Accept: 'application/json', ...(init?.headers ?? {}) } });
  const payload = await response.json().catch(() => ({})) as ApiResult<T>;
  return { response, payload };
}

export function MovementManager(props: MovementManagerProps) {
  const {
    transactions, total, accounts, categories, currency, locale, startDate, endDate,
    accountFilter, categoryFilter, searchText, uncategorizedOnly, sortKey, sortAscending,
    filterKey, onSort, onUpdated,
  } = props;
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchCategoryId, setBatchCategoryId] = useState('');
  const [batchPreview, setBatchPreview] = useState(false);
  const [batchExpectedCategories, setBatchExpectedCategories] = useState<Record<string, string | null>>({});
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState('');
  const [batchNotice, setBatchNotice] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMessage, setExportMessage] = useState('');
  const [editing, setEditing] = useState<MovementTransaction | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [editPreview, setEditPreview] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState('');
  const [editNotice, setEditNotice] = useState('');
  const lastEditId = useRef<string | null>(null);
  const dateInput = useRef<HTMLInputElement>(null);
  const visibleIdKey = JSON.stringify(transactions.map((item) => item.id));
  const selectableTransactions = useMemo(() => transactions.filter(canBulkCategorize), [transactions]);
  const accountNames = useMemo(() => new Map(accounts.map((item) => [item.id, item.name])), [accounts]);
  const categoryNames = useMemo(() => new Map(categories.map((item) => [item.id, item.name])), [categories]);
  const expenseCategories = useMemo(() => categories.filter((category) => !category.isIncome), [categories]);
  const selectedTransactions = useMemo(
    () => transactions.filter((item) => selectedIds.includes(item.id) && canBulkCategorize(item)),
    [transactions, selectedIds],
  );
  const allSelectableSelected = selectableTransactions.length > 0 &&
    selectableTransactions.every((item) => selectedIds.includes(item.id));

  useEffect(() => {
    setSelectedIds([]);
    setBatchCategoryId('');
    setBatchPreview(false);
    setBatchExpectedCategories({});
    setBatchError('');
    setBatchNotice('');
    setExportMessage('');
  }, [filterKey]);

  useEffect(() => {
    // Keep the selection when a parent creates a new array with the same visible rows.
    const visibleIds = new Set<string>(JSON.parse(visibleIdKey) as string[]);
    setSelectedIds((previous) => previous.filter((id) => visibleIds.has(id)));
  }, [visibleIdKey]);

  useEffect(() => {
    if (editing || !lastEditId.current) return;
    const id = lastEditId.current;
    lastEditId.current = null;
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-transaction-edit]'));
    const target = buttons.find((button) => button.getAttribute('data-transaction-edit') === id);
    if (target) target.focus();
    else document.querySelector<HTMLElement>('[data-movement-manager-heading]')?.focus();
  }, [editing?.id]);

  function openEditor(transaction: MovementTransaction): void {
    // Initialize the draft in the same event as opening the dialog so the first
    // render is complete; an effect must not overwrite input entered immediately.
    lastEditId.current = transaction.id;
    setDraft({
      date: transaction.date,
      amount: amountInput(transaction.amount, locale),
      concept: transaction.imported_payee?.trim() || transaction.payee_name?.trim() || '',
      categoryId: transaction.category ?? '',
      notes: transaction.notes ?? '',
      cleared: Boolean(transaction.cleared),
    });
    setEditPreview(false);
    setEditError('');
    setEditNotice('');
    setEditing(transaction);
  }

  function closeEditor(): void {
    setEditing(null);
    setDraft(null);
    setEditPreview(false);
    setEditError('');
  }
  function onDialogKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape' && !editBusy) {
      event.preventDefault();
      closeEditor();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = event.currentTarget;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.tabIndex >= 0);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }
  function changeDraft<K extends keyof EditDraft>(field: K, value: EditDraft[K]): void {
    setDraft((previous) => previous ? { ...previous, [field]: value } : previous);
    setEditPreview(false);
    setEditError('');
    setEditNotice('');
  }
  function buildChanges(): UpdateFields | null {
    if (!editing || !draft) return null;
    if (!isIsoDate(draft.date)) throw new Error('Introduce una fecha real con formato AAAA-MM-DD.');
    const amountMinor = parseAmountInput(draft.amount);
    if (amountMinor === null) throw new Error('El importe debe ser distinto de cero, seguro y tener como máximo dos decimales. No uses separadores de miles.');
    if (editing.transfer_id && Math.sign(amountMinor) !== Math.sign(editing.amount)) {
      throw new Error('No se puede invertir la dirección de una transferencia enlazada desde este editor.');
    }
    if (draft.concept.trim().length > 500) throw new Error('El concepto no puede superar 500 caracteres.');
    if (draft.notes.length > 2_000) throw new Error('Las notas no pueden superar 2.000 caracteres.');
    const fields: UpdateFields = {};
    if (draft.date !== editing.date) fields.date = draft.date;
    if (amountMinor !== editing.amount) fields.amount = amountMinor;
    const originalConcept = editing.imported_payee?.trim() || editing.payee_name?.trim() || '';
    if (!editing.transfer_id && draft.concept.trim() !== originalConcept) fields.imported_payee = draft.concept.trim();
    const nextCategory = draft.categoryId || null;
    if (!editing.transfer_id && nextCategory !== (editing.category ?? null)) fields.category = nextCategory;
    if (draft.notes !== (editing.notes ?? '')) fields.notes = draft.notes;
    if (draft.cleared !== Boolean(editing.cleared)) fields.cleared = draft.cleared;
    if (nextCategory) {
      const category = categories.find((item) => item.id === nextCategory);
      if (!category) throw new Error('Selecciona una categoría disponible.');
      if ((amountMinor > 0) !== category.isIncome) throw new Error('La categoría debe corresponder al tipo de movimiento: ingreso o gasto.');
    }
    if (Object.keys(fields).length === 0) throw new Error('No hay cambios que guardar.');
    return fields;
  }

  async function handleEditSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!editing || !draft || editBusy) return;
    setEditError('');
    setEditNotice('');
    if (!editPreview) {
      try {
        const changes = buildChanges();
        if (!changes) return;
        setEditPreview(true);
      } catch (error) {
        setEditError(error instanceof Error ? error.message : 'No se han podido validar los cambios.');
      }
      return;
    }
    let changes: UpdateFields;
    try {
      const parsed = buildChanges();
      if (!parsed) return;
      changes = parsed;
    } catch (error) {
      setEditPreview(false);
      setEditError(error instanceof Error ? error.message : 'No se han podido validar los cambios.');
      return;
    }
    setEditBusy(true);
    try {
      const { response, payload } = await requestJson<{
        transactionId: string;
        updatedFields: string[];
        persisted: boolean;
        partial?: boolean;
        counterpartTransactionId?: string;
        parentTransactionId?: string;
        parentAmount?: number;
        failedTransactionId?: string;
      }>(
        '/api/v1/transactions/' + encodeURIComponent(editing.id),
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ accountId: editing.account, startDate, endDate, changes }),
        },
      );
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? 'No se han podido guardar los cambios.');
      if (payload.data.partial) {
        const warning = 'Actual Budget solo confirmó una parte de la transferencia enlazada. Se ha actualizado un lado; verifica ambos movimientos en Actual antes de volver a intentarlo.';
        onUpdated(warning);
        throw new Error(warning);
      }
      const notice = editing.transfer_id
        ? 'Transferencia actualizada y verificada en sus dos cuentas de Actual Budget.'
        : editing.is_split_child
          ? 'Parte del desglose actualizada; el conjunto completo se ha conservado y verificado en Actual Budget.'
          : 'Cambios validados y verificados en Actual Budget.';
      setEditNotice(notice);
      lastEditId.current = editing.id;
      setEditing(null);
      setDraft(null);
      setEditPreview(false);
      setSelectedIds([]);
      onUpdated(notice);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : 'No se han podido guardar los cambios.');
    } finally {
      setEditBusy(false);
    }
  }

  const batchPayload = (commit = false) => ({
    startDate, endDate, commit,
    transactions: selectedTransactions.map((item) => ({
      transactionId: item.id,
      categoryId: batchCategoryId,
      ...(commit && Object.hasOwn(batchExpectedCategories, item.id)
        ? { expectedCategoryId: batchExpectedCategories[item.id] }
        : {}),
    })),
  });
  async function previewBatch(): Promise<void> {
    if (batchBusy || !batchCategoryId || selectedTransactions.length === 0) return;
    setBatchBusy(true); setBatchError(''); setBatchNotice('');
    setBatchPreview(false); setBatchExpectedCategories({});
    try {
      const { response, payload } = await requestJson<{
        preview: boolean;
        requested: number;
        changes: number;
        baseline?: readonly { transactionId: string; expectedCategoryId: string | null }[];
      }>(
        '/api/v1/insights/categorize',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batchPayload()) },
      );
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? 'La API no pudo validar el lote.');
      const baseline = payload.data.baseline;
      if (!baseline || baseline.length !== selectedTransactions.length ||
          selectedTransactions.some((item) => !baseline.some((entry) => entry.transactionId === item.id))) {
        throw new Error('La API no devolvió una referencia de categoría verificable para cada movimiento. Vuelve a intentarlo.');
      }
      setBatchExpectedCategories(Object.fromEntries(baseline.map((entry) => [entry.transactionId, entry.expectedCategoryId])));
      setBatchPreview(true);
      setBatchNotice('Previsualización validada: ' + payload.data.changes + ' movimientos de gasto. Se comprobará que sus categorías no cambien antes de escribir; todavía no se ha modificado ningún movimiento.');
    } catch (error) {
      setBatchError(error instanceof Error ? error.message : 'No se ha podido validar el lote.');
    } finally { setBatchBusy(false); }
  }
  async function commitBatch(): Promise<void> {
    if (batchBusy || !batchPreview || !batchCategoryId || selectedTransactions.length === 0) return;
    if (selectedTransactions.some((item) => !Object.hasOwn(batchExpectedCategories, item.id))) {
      setBatchPreview(false);
      setBatchExpectedCategories({});
      setBatchError('La previsualización ya no cubre todos los movimientos seleccionados. Vuelve a previsualizar el lote.');
      return;
    }
    const confirmed = window.confirm('Se cambiará la categoría de ' + selectedTransactions.length + ' movimientos ordinarios de gasto a «' + (categoryNames.get(batchCategoryId) ?? batchCategoryId) + '». Se comprobará que cada categoría siga igual que en la previsualización. Si falla una escritura, solo se volverán a seleccionar los movimientos pendientes; no se realizará una deshacer automática. ¿Continuar?');
    if (!confirmed) return;
    setBatchBusy(true); setBatchError(''); setBatchNotice('');
    try {
      const { response, payload } = await requestJson<{
        requested: number; applied?: number; changes: number; appliedTransactionIds?: string[];
        failedTransactionId?: string; conflictTransactionId?: string; persisted?: boolean; partial?: boolean; message?: string;
      }>('/api/v1/insights/categorize', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batchPayload(true)),
      });
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? 'La API no pudo aplicar el lote.');
      const outcome = payload.data;
      const appliedIds = new Set(outcome.appliedTransactionIds ?? []);
      const batchMessage = outcome.partial || outcome.applied !== outcome.requested || outcome.persisted === false
        ? 'Resultado parcial: ' + (outcome.applied ?? outcome.changes) + ' de ' + outcome.requested + ' movimientos confirmados. ' +
          (outcome.failedTransactionId ? 'Revisa el ID técnico ' + outcome.failedTransactionId + '. ' : '') +
          (outcome.conflictTransactionId ? 'La categoría cambió después de la previsualización. ' : '') +
          (outcome.persisted === false ? 'La persistencia no se ha podido verificar. ' : '') +
          (outcome.message ?? 'Revisa Actual antes de volver a intentarlo; no se ha ejecutado ninguna deshacer automática.')
        : outcome.changes === 1
          ? 'Se ha confirmado la categoría de 1 movimiento en Actual Budget.'
          : 'Se han confirmado las categorías de ' + outcome.changes + ' movimientos en Actual Budget.';
      if (outcome.partial || outcome.applied !== outcome.requested || outcome.persisted === false) {
        setSelectedIds((previous) => previous.filter((id) => !appliedIds.has(id)));
        setBatchPreview(false);
        setBatchExpectedCategories({});
        setBatchNotice(batchMessage + ' Solo quedan seleccionados los movimientos pendientes; previsualiza de nuevo antes de reintentar. La tabla se mantiene para conservar la selección; los cambios confirmados ya están en Actual y la vista se recargará al completar el lote.');
      } else {
        setSelectedIds([]);
        setBatchPreview(false);
        setBatchExpectedCategories({});
        setBatchCategoryId('');
        setBatchNotice(batchMessage);
      }
      onUpdated(batchMessage, !(outcome.partial || outcome.applied !== outcome.requested || outcome.persisted === false));
    } catch (error) {
      setBatchPreview(false);
      setBatchExpectedCategories({});
      setBatchError(error instanceof Error ? error.message : 'No se ha podido completar el lote. Vuelve a previsualizar antes de reintentar.');
    } finally { setBatchBusy(false); }
  }

  async function exportCsv(): Promise<void> {
    if (exportBusy) return;
    setExportBusy(true); setExportMessage('');
    try {
      const allRows: MovementTransaction[] = [];
      const pageLimit = 200;
      const filters = new URLSearchParams({ startDate, endDate, limit: String(pageLimit), offset: '0', sortBy: sortKey, order: sortAscending ? 'asc' : 'desc' });
      if (accountFilter !== 'all') filters.set('accountId', accountFilter);
      if (categoryFilter !== 'all') filters.set('categoryId', categoryFilter);
      if (uncategorizedOnly) filters.set('uncategorized', 'true');
      if (searchText.trim()) filters.set('search', searchText.trim());
      const first = await requestJson<MovementTransaction[]>('/api/v1/transactions?' + filters.toString());
      if (!first.response.ok || !first.payload.data) throw new Error(first.payload.error?.message ?? 'No se han podido consultar los movimientos para exportar.');
      const expected = first.payload.pagination?.total ?? first.payload.data.length;
      const maxExport = 10_000;
      if (expected > maxExport) throw new Error('El resultado incluye ' + expected + ' movimientos. Acota el periodo o los filtros a 10.000 movimientos o menos para exportar de forma segura.');
      allRows.push(...first.payload.data);
      for (let offset = pageLimit; offset < expected; offset += pageLimit) {
        filters.set('offset', String(offset));
        const { response, payload } = await requestJson<MovementTransaction[]>('/api/v1/transactions?' + filters.toString());
        if (!response.ok || !payload.data || payload.data.length === 0) throw new Error(payload.error?.message ?? 'La consulta exportable cambió o quedó incompleta; no se ha generado ningún archivo.');
        allRows.push(...payload.data);
      }
      if (allRows.length !== expected) throw new Error('El total consultado cambió durante la exportación. Ajusta los filtros y vuelve a intentarlo.');
      const headers = ['fecha', 'concepto', 'cuenta', 'categoria', 'importe_minor', 'divisa', 'notas', 'conciliado', 'id_movimiento', 'id_transferencia'];
      const rows = allRows.map((item) => [
        item.date,
        transactionDescription(item),
        accountNames.get(item.account) ?? 'Cuenta desconocida',
        categoryNames.get(item.category ?? '') ?? '',
        String(item.amount),
        item.currencyCode ?? item.currency_code ?? '',
        item.notes ?? '',
        item.cleared ? 'sí' : 'no',
        item.id,
        item.transfer_id ?? '',
      ]);
      const csv = '\uFEFF' + [headers, ...rows].map((row) => row.map((value, index) => safeCsvCell(value, [1, 2, 3, 5, 6, 8, 9].includes(index))).join(';')).join('\r\n') + '\r\n';
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'movimientos-filtrados-' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportMessage('Archivo CSV generado en el navegador: ' + allRows.length + ' movimientos con filtros actuales. El servidor no conserva la exportación.');
    } catch (error) {
      setExportMessage(error instanceof Error ? error.message : 'No se ha podido generar el archivo CSV.');
    } finally { setExportBusy(false); }
  }

  return (
    <section className="movement-manager" aria-label="Gestión de movimientos">
      <div className="movement-actions-toolbar panel">
        <div className="movement-actions-heading">
          <div><p className="eyebrow">ACCIONES SEGURAS</p><h3 tabIndex={-1} data-movement-manager-heading>Selección y exportación</h3></div>
          <span className="date-badge">{total} resultados · {selectedIds.length} seleccionados</span>
        </div>
        <p className="setting-hint">La selección se limita a la página visible. La categorización por lote solo incluye gastos ordinarios; las transferencias, ingresos y movimientos divididos se protegen de acciones en lote.</p>
        <div className="movement-actions-controls">
          <label className="field-label">Categoría de gasto para el lote
            <select value={batchCategoryId} onChange={(event) => { setBatchCategoryId(event.currentTarget.value); setBatchPreview(false); setBatchExpectedCategories({}); setBatchNotice(''); setBatchError(''); }}>
              <option value="">Selecciona categoría…</option>
              {expenseCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select>
          </label>
          <div className="button-row">
            <button className="button secondary" type="button" disabled={!selectedTransactions.length || !batchCategoryId || batchBusy} onClick={() => { void previewBatch(); }}>Previsualizar lote</button>
            <button className="button primary" type="button" disabled={!batchPreview || !selectedTransactions.length || !batchCategoryId || batchBusy} onClick={() => { void commitBatch(); }}>{batchBusy ? 'Procesando…' : 'Confirmar lote'}</button>
            <button className="button secondary" type="button" disabled={exportBusy} onClick={() => { void exportCsv(); }}>{exportBusy ? 'Exportando…' : 'Exportar CSV filtrado'}</button>
          </div>
        </div>
        {batchError ? <p className="form-alert error" role="alert">{batchError}</p> : null}
        {batchNotice ? <p className="form-alert" role="status">{batchNotice}</p> : null}
        {exportMessage ? <p className="form-alert" role="status">{exportMessage}</p> : null}
      </div>
      {editNotice ? <p className="form-alert" role="status">{editNotice}</p> : null}
      {transactions.length === 0 ? <div className="empty-state"><span className="empty-symbol" aria-hidden="true">◇</span><h3>No se han encontrado movimientos</h3><p>Cambia el periodo o los filtros. Esta vista no inventa datos cuando Actual no devuelve resultados.</p></div> : (
        <div className="table-wrap" role="region" aria-label="Movimientos paginados; desplázate horizontalmente para ver todas las columnas" tabIndex={0}>
          <table className="transactions-table">
            <thead><tr>
              <th scope="col"><input type="checkbox" aria-label="Seleccionar todos los gastos ordinarios de esta página" checked={allSelectableSelected} onChange={(event) => { const checked = event.currentTarget.checked; setSelectedIds(checked ? selectableTransactions.map((item) => item.id) : []); setBatchPreview(false); setBatchExpectedCategories({}); setBatchNotice(''); }} /></th>
              <th scope="col"><button type="button" className="sort-button" onClick={() => onSort('date')}>Fecha{sortKey === 'date' ? (sortAscending ? ' ↑' : ' ↓') : ''}</button></th>
              <th scope="col"><button type="button" className="sort-button" onClick={() => onSort('description')}>Descripción{sortKey === 'description' ? (sortAscending ? ' ↑' : ' ↓') : ''}</button></th>
              <th scope="col">Cuenta</th><th scope="col">Categoría</th>
              <th scope="col"><button type="button" className="sort-button" onClick={() => onSort('amount')}>Importe{sortKey === 'amount' ? (sortAscending ? ' ↑' : ' ↓') : ''}</button></th><th scope="col">Estado</th><th scope="col">Acción</th>
            </tr></thead>
            <tbody>{transactions.map((transaction) => {
              const category = categories.find((item) => item.id === transaction.category);
              const editable = canEdit(transaction);
              const bulkSelectable = canBulkCategorize(transaction);
              const description = transactionDescription(transaction);
              const reason = transaction.transfer_id ? 'Las transferencias deben editarse juntas en Actual Budget.' : 'Los movimientos divididos se protegen para evitar perder o duplicar apuntes.';
              return <tr key={transaction.id}>
                <td><input type="checkbox" aria-label={'Seleccionar ' + description} checked={selectedIds.includes(transaction.id)} disabled={!bulkSelectable} title={!bulkSelectable ? (editable ? 'La categorización en lote está limitada a gastos.' : reason) : undefined} onChange={(event) => { const checked = event.currentTarget.checked; setSelectedIds((previous) => checked ? [...previous.filter((id) => id !== transaction.id), transaction.id] : previous.filter((id) => id !== transaction.id)); setBatchPreview(false); setBatchExpectedCategories({}); setBatchNotice(''); }} /></td>
                <td>{formatCivilDate(transaction.date, locale)}</td>
                <td><strong className="transaction-name">{description}</strong>{transaction.notes ? <small className="transaction-note">{transaction.notes}</small> : null}</td>
                <td>{accountNames.get(transaction.account) ?? 'Cuenta desconocida'}</td>
                <td>{category?.name ?? <span className="uncategorized">Sin categoría</span>}</td>
                <td className={'amount-cell ' + (transaction.amount < 0 ? 'expense' : 'income')}>{transaction.displayAmountMinor !== null && transaction.displayAmountMinor !== undefined
                  ? formatMoney(transaction.displayAmountMinor, transaction.displayCurrency ?? currency, locale)
                  : <span title="No hay conversión válida">{formatMoney(transaction.amount, transaction.currencyCode ?? currency, locale)}<small className="warning-text">Sin conversión de análisis</small></span>}</td>
                <td><span className={'cleared-badge ' + (transaction.cleared ? 'cleared' : '')}>{transaction.cleared ? 'Conciliado' : 'Pendiente'}</span></td>
                <td><button className="button small secondary" type="button" data-transaction-edit={transaction.id} disabled={!editable} title={!editable ? reason : 'Editar movimiento'} onClick={() => openEditor(transaction)}>Editar</button></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      )}
      <p className="setting-hint movement-export-note">El CSV incluye todos los resultados de los filtros actuales (no solo la página visible), con importes enteros en unidades menores y divisa de origen. Las exportaciones solo se descargan en el navegador; no se guardan en el servidor.</p>
      {editing && draft ? (
        <div className="transaction-edit-backdrop">
          <div className="transaction-edit-dialog panel" role="dialog" aria-modal="true" aria-labelledby="transaction-edit-title" onKeyDown={onDialogKeyDown}>
            <div className="section-heading"><div><p className="eyebrow">EDICIÓN DE MOVIMIENTO</p><h2 id="transaction-edit-title">Revisar cambios</h2></div><button className="button secondary" type="button" disabled={editBusy} onClick={closeEditor}>Cerrar</button></div>
            <p className="setting-hint">{editing.transfer_id
              ? 'La transferencia está enlazada: fecha e importe se aplican a las dos patas; notas y conciliación solo afectan a este lado. No se puede cambiar su dirección ni su categoría desde aquí.'
              : editing.is_split_child
                ? 'Esta parte se guarda reenviando el desglose completo con todos sus IDs. Categoría y notas pertenecen a esta parte; fecha, concepto y conciliación afectan al movimiento padre. Cambiar el importe recalcula el total del padre.'
                : 'La cuenta de origen la controla Actual Budget y no se puede cambiar aquí. Los campos se validan en servidor antes de guardar.'}</p>
            <form onSubmit={(event) => { void handleEditSubmit(event); }}>
              <div className="edit-fields-grid">
                <label className="field-label">Fecha<input ref={dateInput} autoFocus type="date" required value={draft.date} onChange={(event) => changeDraft('date', event.currentTarget.value)} /></label>
                <label className="field-label">Importe (unidades principales)<input required inputMode="decimal" autoComplete="off" value={draft.amount} onChange={(event) => changeDraft('amount', event.currentTarget.value)} aria-describedby="edit-amount-hint" /><small id="edit-amount-hint">Ejemplo: 1234,56. No uses separadores de miles.</small></label>
                <label className="field-label edit-full-width">Concepto importado<input maxLength={500} disabled={Boolean(editing.transfer_id)} value={draft.concept} onChange={(event) => changeDraft('concept', event.currentTarget.value)} /></label>
                {editing.transfer_id ? <p className="setting-hint">El enlace y el beneficiario de transferencia están protegidos.</p> : <label className="field-label">Categoría<select value={draft.categoryId} onChange={(event) => changeDraft('categoryId', event.currentTarget.value)}><option value="">Sin categoría</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}{category.isIncome ? ' · Ingreso' : ' · Gasto'}</option>)}</select></label>}
                <label className="field-label">Cuenta<input value={accountNames.get(editing.account) ?? 'Cuenta desconocida'} disabled readOnly /></label>
                <label className="field-label edit-full-width">Notas<textarea rows={3} maxLength={2000} value={draft.notes} onChange={(event) => changeDraft('notes', event.currentTarget.value)} /></label>
                <label className="check-field edit-full-width"><input type="checkbox" checked={draft.cleared} onChange={(event) => changeDraft('cleared', event.currentTarget.checked)} /> Movimiento conciliado</label>
              </div>
              {editPreview ? (
                <section className="confirmation-panel" aria-label="Previsualización de cambios">
                  <h4>Previsualización — todavía sin guardar</h4>
                  <p><strong>{transactionDescription(editing)}</strong> · {formatCivilDate(editing.date, locale)} · {formatMoney(editing.amount, editing.currencyCode ?? currency, locale)}</p>
                  <p>Nuevo valor: <strong>{draft.concept.trim() || 'Sin concepto'}</strong> · {formatCivilDate(draft.date, locale)} · {parseAmountInput(draft.amount) === null ? 'Importe inválido' : formatMoney(parseAmountInput(draft.amount) as number, editing.currencyCode ?? currency, locale)}</p>
                  <p>Categoría: {categoryNames.get(editing.category ?? '') ?? 'Sin categoría'} → {categoryNames.get(draft.categoryId) ?? 'Sin categoría'}; estado: {editing.cleared ? 'Conciliado' : 'Pendiente'} → {draft.cleared ? 'Conciliado' : 'Pendiente'}.</p>
                  <p>Notas: <strong>{editing.notes?.trim() || 'Sin notas'}</strong> → <strong>{draft.notes.trim() || 'Sin notas'}</strong>.</p>
                </section>
              ) : null}
              {editError ? <p className="form-alert error" role="alert">{editError}</p> : null}
              {editNotice ? <p className="form-alert" role="status">{editNotice}</p> : null}
              <div className="button-row">
                <button className="button secondary" type="button" disabled={editBusy} onClick={closeEditor}>Cancelar</button>
                {editPreview ? <button className="button primary" type="submit" disabled={editBusy}>{editBusy ? 'Guardando…' : 'Confirmar y guardar'}</button> : <button className="button primary" type="submit" disabled={editBusy}>Previsualizar cambios</button>}
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}
