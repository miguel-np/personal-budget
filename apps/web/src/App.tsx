import { useEffect, useState } from 'react';

type ServiceStatus = 'checking' | 'available' | 'unavailable';

export function App() {
  const [status, setStatus] = useState<ServiceStatus>('checking');

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/health', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Health check failed.');
        return response.json() as Promise<{ status: string }>;
      })
      .then((payload) => setStatus(payload.status === 'ok' ? 'available' : 'unavailable'))
      .catch(() => {
        if (!controller.signal.aborted) setStatus('unavailable');
      });
    return () => controller.abort();
  }, []);

  const statusText = {
    checking: 'Comprobando el servicio local…',
    available: 'El backend local responde. El dashboard se implementará en la siguiente fase.',
    unavailable: 'El backend local no está disponible. Comprueba la instalación de personal-budget.',
  } satisfies Record<ServiceStatus, string>;

  return (
    <main className="page-shell">
      <aside className="sidebar" aria-label="Navegación principal">
        <div className="brand-mark" aria-hidden="true">pb</div>
        <div>
          <p className="eyebrow">FINANZAS PERSONALES</p>
          <h1>personal-budget</h1>
          <p className="muted">Local · Privado · Bajo tu control</p>
        </div>
        <nav className="nav-list" aria-label="Secciones">
          <span className="nav-item active" aria-current="page">Resumen</span>
          <span className="nav-item disabled">Movimientos</span>
          <span className="nav-item disabled">Informes</span>
          <span className="nav-item disabled">Asistente IA</span>
          <span className="nav-item disabled">Configuración</span>
        </nav>
        <div className="privacy-note">
          <strong>Diseño local-first</strong>
          <p>Las conexiones externas y la sincronización bancaria automática no están habilitadas por defecto.</p>
        </div>
      </aside>

      <section className="main-content" aria-labelledby="page-title">
        <header className="topbar">
          <div>
            <p className="eyebrow">ÁREA PERSONAL</p>
            <h2 id="page-title">Resumen financiero</h2>
          </div>
          <span className={'service-pill ' + status} role="status">
            <span className="status-dot" aria-hidden="true" />
            {status === 'available' ? 'Servicio local' : status === 'checking' ? 'Conectando' : 'Sin conexión'}
          </span>
        </header>

        <div className="welcome-panel">
          <p className="eyebrow">FASE P0 · FUNDAMENTOS</p>
          <h3>La base privada está preparada para conectar tus finanzas.</h3>
          <p className="welcome-copy">En la siguiente fase se añadirán el registro de movimientos, la importación y los informes de gastos y ahorro diarios, mensuales y anuales. No se muestran cifras inventadas como si fueran datos reales.</p>
          <p className={'backend-status ' + status} role="status">{statusText[status]}</p>
        </div>

        <div className="empty-grid" aria-label="Funciones previstas">
          <article className="empty-card"><span className="card-number">01</span><h4>Ingresos y gastos</h4><p>Movimientos obtenidos de Actual Budget.</p><span className="state-label">Pendiente · P1</span></article>
          <article className="empty-card"><span className="card-number">02</span><h4>Ahorro por periodo</h4><p>Totales deterministas, con traspasos excluidos.</p><span className="state-label">Pendiente · P1</span></article>
          <article className="empty-card"><span className="card-number">03</span><h4>Análisis por categoría</h4><p>Distribución de gastos y presupuesto frente a real.</p><span className="state-label">Pendiente · P1</span></article>
        </div>
      </section>
    </main>
  );
}
