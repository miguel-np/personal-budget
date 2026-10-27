import { useMemo, useState } from 'react';
import { assessNetWorth } from './financial-signals.js';
import { formatAccountBalance, formatUnconvertedMoney } from './finance-format.js';

interface Account {
  readonly id: string;
  readonly name: string;
  readonly closed: boolean;
  readonly offBudget: boolean;
  readonly currentBalanceMinor: number | null;
  readonly currencyCode?: string | null;
  readonly nativeCurrencyCode?: string | null;
  readonly displayBalanceMinor?: number | null;
  readonly displayCurrency?: string;
  readonly classification?: 'asset' | 'liability' | null;
  readonly balanceConversion?: { readonly warning?: string };
}

interface AccountsPanelProps {
  readonly accounts: readonly Account[];
  readonly currency: string;
  readonly activeAccountIds: readonly string[];
  readonly onOpenMovements: (accountId: string) => void;
}

export function AccountsPanel({ accounts, currency, activeAccountIds, onOpenMovements }: AccountsPanelProps) {
  const [includeOffBudget, setIncludeOffBudget] = useState(true);
  const activeIds = useMemo(() => new Set(activeAccountIds), [activeAccountIds]);
  const openAccounts = accounts.filter((account) => !account.closed);
  const knownBalances = openAccounts.filter((account) => account.currentBalanceMinor !== null);
  const offBudgetCount = openAccounts.filter((account) => account.offBudget).length;
  const assessment = assessNetWorth(accounts, currency, activeAccountIds, includeOffBudget);

  return (
    <section className="content-section" aria-labelledby="accounts-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">FUENTE DE VERDAD: ACTUAL BUDGET</p>
          <h2 id="accounts-heading">Cuentas y saldos</h2>
        </div>
        <span className="date-badge">Divisa de análisis: {currency}</span>
      </div>
      <p className="section-context">Consulta de saldos actuales. No son flujo de caja del periodo ni una medida de dinero disponible para gastar.</p>

      <div className="stats-grid account-stats-grid">
        <article className="stat-card"><p>Cuentas abiertas</p><strong>{openAccounts.length}</strong><span>Las cerradas se conservan en el listado como referencia.</span></article>
        <article className="stat-card"><p>Saldos conocidos</p><strong>{knownBalances.length} / {openAccounts.length}</strong><span>Un saldo desconocido no se sustituye por cero.</span></article>
        <article className="stat-card"><p>Fuera de presupuesto</p><strong>{offBudgetCount}</strong><span>Se identifican explícitamente; no se ocultan ni se confunden con cuentas del presupuesto.</span></article>
      </div>

      <article className="panel net-worth-panel" aria-labelledby="net-worth-heading">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">RESUMEN PATRIMONIAL</p>
            <h3 id="net-worth-heading">Patrimonio neto</h3>
          </div>
          <span className="status-chip">{assessment.status === 'available' ? 'Completo' : assessment.status === 'incomplete' ? 'Incompleto' : 'No disponible'}</span>
        </div>
        <div className="net-worth-value">{assessment.amountMinor === null ? 'No disponible' : new Intl.NumberFormat('es-ES', { style: 'currency', currency, maximumFractionDigits: 2 }).format(assessment.amountMinor / 100)}</div>
        <p>El patrimonio neto solo se calcula cuando cada cuenta incluida tiene una clasificación fiable de activo o pasivo y un saldo disponible convertido a la divisa de análisis. No se infiere una deuda a partir de un saldo negativo ni del nombre de la cuenta.</p>
        {assessment.reasons.map((reason) => <p className="signal-note" key={reason}>{reason}</p>)}
        <label className="check-field net-worth-toggle">
          <input type="checkbox" checked={includeOffBudget} onChange={(event) => setIncludeOffBudget(event.currentTarget.checked)} />
          Incluir cuentas fuera de presupuesto en el ámbito patrimonial
        </label>
        <p className="setting-hint">
          {includeOffBudget
            ? 'Las cuentas fuera de presupuesto permanecen dentro del ámbito solicitado, pero no se agregan a un total mientras falte la clasificación y validación de saldos.'
            : 'Las cuentas fuera de presupuesto quedan excluidas explícitamente del ámbito solicitado. El total sigue sin calcularse porque falta una clasificación fiable de activo/pasivo.'}
        </p>
        <p className="muted-copy">Ámbito global activo: {activeAccountIds.length} cuenta(s) abierta(s). El detalle siguiente permite auditar cada saldo y estado.</p>
      </article>

      <div className="accounts-list" aria-label="Listado de cuentas de Actual Budget">
        {accounts.length === 0 ? (
          <article className="panel"><div className="empty-state"><h3>No hay cuentas para mostrar</h3><p>Actual Budget no ha devuelto cuentas. Comprueba el presupuesto configurado antes de sacar conclusiones patrimoniales.</p></div></article>
        ) : accounts.map((account) => {
          const isActive = activeIds.has(account.id);
          const nativeCurrency = account.nativeCurrencyCode ?? account.currencyCode ?? null;
          const displayCurrency = account.displayCurrency ?? currency;
          const displayBalance = account.displayBalanceMinor;
          const hasConvertedBalance = displayBalance !== null && displayBalance !== undefined;
          const statusLabel = account.closed ? 'Cerrada' : 'Abierta';
          return (
            <article className="panel account-card" key={account.id}>
              <div className="account-card-header">
                <div>
                  <h3>{account.name}</h3>
                  <p className="muted-copy">Cuenta gestionada por Actual Budget</p>
                </div>
                <div className="account-badges">
                  <span className={'account-badge' + (account.closed ? ' closed' : ' open')}>{statusLabel}</span>
                  <span className="account-badge">{account.offBudget ? 'Fuera de presupuesto' : 'Dentro del presupuesto'}</span>
                </div>
              </div>
              <dl className="account-balance-grid">
                <div>
                  <dt>Saldo actual</dt>
                  <dd>{formatAccountBalance(account.currentBalanceMinor, displayBalance, displayCurrency, nativeCurrency)}</dd>
                  <small>{hasConvertedBalance ? 'Convertido a ' + displayCurrency : 'Se muestra el saldo nativo si se conoce la moneda.'}</small>
                </div>
                {nativeCurrency && (nativeCurrency !== displayCurrency || !hasConvertedBalance) ? (
                  <div>
                    <dt>Saldo en moneda nativa</dt>
                    <dd>{account.currentBalanceMinor === null ? 'Saldo desconocido' : formatUnconvertedMoney(account.currentBalanceMinor, nativeCurrency)}</dd>
                    <small>{nativeCurrency === displayCurrency ? 'Sin conversión adicional.' : account.balanceConversion?.warning ?? 'El equivalente depende de una conversión válida.'}</small>
                  </div>
                ) : null}
                <div>
                  <dt>Contribución al patrimonio</dt>
                  <dd>No calculada</dd>
                  <small>Clasificación activo/pasivo no disponible.</small>
                </div>
              </dl>
              <div className="account-card-footer">
                <p className="muted-copy">
                  {account.closed
                    ? 'Cuenta cerrada: no se habilita el filtro de movimientos en esta vista.'
                    : isActive
                      ? 'Incluida en el ámbito global de análisis.'
                      : 'No está incluida en el ámbito global de cuentas seleccionado.'}
                </p>
                <button className="button secondary" type="button" disabled={account.closed || !isActive}
                  onClick={() => onOpenMovements(account.id)}>
                  Ver movimientos
                </button>
              </div>
            </article>
          );
        })}
      </div>

      <p className="section-footnote">Actual entrega el saldo actual, no una serie histórica completa con saldo inicial verificable. No se muestra evolución de saldo si no puede reconstruirse con datos fiables. Para ver movimientos, usa el acceso de cada cuenta abierta incluida en el ámbito actual.</p>
    </section>
  );
}
