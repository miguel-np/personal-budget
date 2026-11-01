import { useEffect, useState } from 'react';
import { formatMoney as sharedFormatMoney } from './finance-format.js';
import type { CalendarItem } from './GoalsPanel.js';

interface ApiPayload<T> { data?: T; error?: { code?: string; message?: string }; }
interface DashboardGoalSummary {
  goals: readonly {
    id: string;
    name: string;
    status: string;
    projection: { projectedBalanceMinor: number; currency: string } | null;
    scopeMatches: boolean;
    currencyMatches: boolean;
  }[];
  calendarItems: readonly CalendarItem[];
  asOfDate: string;
  currency: string;
}

function localDate(date = new Date()): string {
  return [String(date.getFullYear()).padStart(4, '0'), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
function monthNow(): string { return localDate().slice(0, 7); }
function money(amountMinor: number, currency: string): string {
  return sharedFormatMoney(amountMinor, currency);
}
function civilDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(date + 'T12:00:00.000Z'));
}

export function GoalsDashboardSummary({ currency, onNavigate, reloadKey = 0 }: { currency: string; onNavigate: (href: string) => void; reloadKey?: number }) {
  const [summary, setSummary] = useState<DashboardGoalSummary | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/v1/planning?month=' + encodeURIComponent(monthNow()), {
          signal: controller.signal, headers: { Accept: 'application/json' },
        });
        const payload = await response.json() as ApiPayload<DashboardGoalSummary>;
        if (response.ok && payload.data && !controller.signal.aborted) setSummary(payload.data);
      } catch {
        // Planning is optional to the dashboard and must not break core financial views.
      }
    })();
    return () => controller.abort();
  }, [reloadKey]);

  if (!summary) {
    return (
      <section className="panel goals-dashboard-panel" aria-labelledby="goals-dashboard-heading">
        <div className="panel-heading"><div><p className="eyebrow">PLANIFICACIÓN</p><h3 id="goals-dashboard-heading">Objetivos y próximos compromisos</h3></div></div>
        <p className="muted-copy">La planificación estará disponible cuando la API local pueda consultar los datos de este presupuesto.</p>
        <div className="button-row"><button className="button secondary" type="button" onClick={() => onNavigate('/goals')}>Abrir objetivos</button></div>
      </section>
    );
  }
  const activeGoals = summary.goals.filter((goal) => goal.status === 'active');
  const upcoming = [...summary.calendarItems].filter((item) => item.date > summary.asOfDate).sort((a, b) => a.date.localeCompare(b.date))[0];
  return (
    <section className="panel goals-dashboard-panel" aria-labelledby="goals-dashboard-heading">
      <div className="panel-heading"><div><p className="eyebrow">PLANIFICACIÓN</p><h3 id="goals-dashboard-heading">Objetivos y próximos compromisos</h3></div></div>
      <div className="goals-dashboard-metrics">
        <div><span>Objetivos activos</span><strong>{activeGoals.length}</strong></div>
        <div><span>Próximo elemento</span><strong>{upcoming ? civilDate(upcoming.date) : 'Sin vencimientos'}</strong></div>
      </div>
      {activeGoals.slice(0, 3).map((goal) => (
        <div className="goal-dashboard-row" key={goal.id}>
          <span>{goal.name}</span>
          <strong>{goal.projection ? money(goal.projection.projectedBalanceMinor, goal.projection.currency) + ' estimados' : 'Revisar supuestos'}</strong>
        </div>
      ))}
      {upcoming ? <p className="section-context">Próximo: {upcoming.title} · {upcoming.direction === 'expense' ? 'Salida' : 'Entrada'} {money(upcoming.amountMinor, summary.currency || currency)} · {upcoming.source === 'actual_transaction' ? 'registrado en Actual' : upcoming.source === 'recurring_candidate' ? 'candidato no confirmado' : 'compromiso manual'}.</p> : <p className="muted-copy">No se han detectado vencimientos futuros en el mes actual.</p>}
      <div className="button-row"><button className="button secondary" type="button" onClick={() => onNavigate('/goals')}>Gestionar objetivos y compromisos</button></div>
    </section>
  );
}
