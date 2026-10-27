import { useCallback, useEffect, useState } from 'react';

export interface AppPreferences {
  theme: 'system' | 'dark' | 'light';
  locale: 'es-ES' | 'en-GB';
}
interface ServiceState { label: string; detail: string; state: 'checking' | 'ok' | 'warning' | 'error' }
interface SettingsCenterProps {
  preferences: AppPreferences;
  onChange: (preferences: AppPreferences) => void;
  onSave: () => void;
  onReset: () => void;
  saving: boolean;
  saveError: string;
  saveNotice: string;
  resetting: boolean;
  resetError: string;
  resetNotice: string;
  currency: string;
  budgetCurrency: string;
  accountCount: number;
  categoryCount: number;
}
async function readStatus(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String((data.error as { message?: string } | undefined)?.message ?? 'El servicio no respondió correctamente.'));
  return data;
}
function statusIcon(state: ServiceState['state']): string {
  return state === 'ok' ? 'Disponible' : state === 'warning' ? 'No configurado' : state === 'error' ? 'No disponible' : 'Comprobando…';
}

export function SettingsCenter(props: SettingsCenterProps) {
  const {
    preferences, onChange, onSave, onReset, saving, saveError, saveNotice, resetting, resetError, resetNotice,
    currency, budgetCurrency, accountCount, categoryCount,
  } = props;
  const [services, setServices] = useState<ServiceState[]>([
    { label: 'API local', detail: 'Comprobando el backend en este equipo.', state: 'checking' },
    { label: 'Actual Budget', detail: 'Comprobando el presupuesto configurado.', state: 'checking' },
    { label: 'Asistente local', detail: 'Comprobando Ollama y el modelo configurado.', state: 'checking' },
  ]);
  const [checking, setChecking] = useState(false);
  const [serviceError, setServiceError] = useState('');

  const refreshServices = useCallback(async () => {
    setChecking(true);
    setServiceError('');
    const results: ServiceState[] = [];
    try {
      await readStatus('/health');
      results.push({ label: 'API local', detail: 'El backend responde en el equipo.', state: 'ok' });
    } catch (error) {
      results.push({ label: 'API local', detail: error instanceof Error ? error.message : 'No se pudo comprobar la API local.', state: 'error' });
    }
    try {
      await readStatus('/ready');
      results.push({ label: 'Actual Budget', detail: 'El adaptador local declara el presupuesto configurado; esto no sustituye una prueba de lectura reciente.', state: 'ok' });
    } catch {
      results.push({ label: 'Actual Budget', detail: 'El presupuesto no está configurado o el adaptador no está disponible.', state: 'warning' });
    }
    try {
      const assistant = await readStatus('/api/v1/assistant/status');
      const enabled = assistant.enabled === true;
      const status = String(assistant.status ?? 'unknown');
      results.push({
        label: 'Asistente local',
        detail: !enabled ? 'Desactivado. La aplicación financiera funciona sin el asistente.' : status === 'available' ? 'Ollama y el modelo están disponibles en local.' : 'Activado, pero el modelo local no está disponible en este momento.',
        state: !enabled ? 'warning' : status === 'available' ? 'ok' : 'warning',
      });
    } catch (error) {
      results.push({ label: 'Asistente local', detail: error instanceof Error ? error.message : 'No se pudo consultar el estado del asistente.', state: 'warning' });
    }
    setServices(results);
    if (results[0]?.state === 'error') setServiceError('La API local no responde. Comprueba el proceso local y vuelve a intentarlo.');
    setChecking(false);
  }, []);

  useEffect(() => { void refreshServices(); }, [refreshServices]);

  return (
    <section className="content-section settings-center" aria-labelledby="settings-center-heading">
      <div className="section-heading"><div><p className="eyebrow">PREFERENCIAS Y DATOS LOCALES</p><h2 id="settings-center-heading">Centro de configuración</h2></div>
        <button className="button secondary" type="button" disabled={checking} onClick={() => { void refreshServices(); }}>{checking ? 'Comprobando…' : 'Actualizar diagnóstico'}</button>
      </div>
      <div className="settings-grid">
        <article className="panel settings-panel">
          <p className="eyebrow">ESTADO DEL SERVICIO</p><h3>Conexiones locales</h3>
          {services.map((service) => (
            <div className="settings-service-row" key={service.label}>
              <span className={'settings-service-dot ' + service.state} aria-hidden="true" />
              <div><strong>{service.label}</strong><small>{service.detail}</small></div>
              <span className={'settings-service-state ' + service.state}>{statusIcon(service.state)}</span>
            </div>
          ))}
          {serviceError ? <p className="form-alert error" role="alert">{serviceError}</p> : null}
          <p className="setting-hint">El estado de disponibilidad no muestra contraseñas, URL privadas, IDs del presupuesto ni rutas absolutas. Los diagnósticos se consultan en la propia máquina.</p>
        </article>
        <article className="panel settings-panel">
          <p className="eyebrow">PREFERENCIAS DE INTERFAZ</p><h3>Apariencia y formato regional</h3>
          <label className="field-label">Tema
            <select value={preferences.theme} onChange={(event) => onChange({ ...preferences, theme: event.currentTarget.value as AppPreferences['theme'] })}>
              <option value="system">Seguir el sistema</option><option value="light">Claro</option><option value="dark">Oscuro</option>
            </select>
          </label>
          <label className="field-label">Formato de fechas e importes
            <select value={preferences.locale} onChange={(event) => onChange({ ...preferences, locale: event.currentTarget.value as AppPreferences['locale'] })}>
              <option value="es-ES">Español (España) · 1.234,56 · 27/10/2026</option>
              <option value="en-GB">English (UK) · 1,234.56 · 27/10/2026</option>
            </select>
          </label>
          <p className="setting-hint">La región cambia la presentación compartida de fechas e importes, no las cantidades guardadas en Actual. El tema no cambia datos financieros.</p>
          <div className="button-row"><button className="button primary" type="button" disabled={saving} onClick={onSave}>{saving ? 'Guardando…' : 'Guardar preferencias de interfaz'}</button></div>
          {saveError ? <p className="form-alert error" role="alert">{saveError}</p> : null}
          {saveNotice ? <p className="form-alert" role="status">{saveNotice}</p> : null}
        </article>
      </div>
      <article className="panel settings-panel">
        <p className="eyebrow">PRESUPUESTO Y DIVISA</p><h3>Estado de los datos financieros</h3>
        <div className="settings-metrics">
          <div><span>Cuentas consultadas</span><strong>{accountCount}</strong></div>
          <div><span>Categorías cargadas</span><strong>{categoryCount}</strong></div>
          <div><span>Divisa del presupuesto</span><strong>{budgetCurrency}</strong></div>
          <div><span>Divisa de análisis</span><strong>{currency}</strong></div>
        </div>
        <p className="setting-hint">Las cuentas, los movimientos, las categorías, los presupuestos y los enlaces entre transferencias pertenecen a Actual Budget. Las preferencias de esta aplicación no contienen un segundo libro financiero.</p>
        <div className="settings-link-row">
          <a className="button secondary" href="/movements">Abrir Movimientos</a>
          <a className="button secondary" href="/reports">Abrir informes</a>
        </div>
        <p className="setting-hint">En Movimientos puedes importar CSV con previsualización y descargar todos los resultados filtrados. La exportación se construye en el navegador y no se conserva en el servidor; para borrar un CSV ya descargado, elimínalo desde el gestor de archivos del sistema.</p>
      </article>
      <article className="panel settings-panel">
        <p className="eyebrow">PRIVACIDAD Y ALMACENAMIENTO</p><h3>Qué guarda esta aplicación</h3>
        <ul className="privacy-list">
          <li>Las preferencias de interfaz, divisa y ámbito de cuentas se guardan como archivos JSON locales en el directorio de datos configurado, con permisos de archivo restrictivos.</li>
          <li>Los movimientos y los presupuestos siguen en el presupuesto de Actual Budget; esta pantalla no crea una copia financiera paralela.</li>
          <li>No se envían datos a analítica ni a servicios en la nube desde las funciones de esta pantalla. El asistente es opcional y local.</li>
          <li>Las contraseñas, claves de cifrado, IDs del presupuesto y el contenido de <code>.env</code> no se muestran ni se editan aquí.</li>
        </ul>
        <h4>Copias de seguridad y restauración</h4>
        <p className="setting-hint">Las copias creadas por <code>npm run backup:actual</code> se cifran con AES-256-GCM y la clave se conserva por separado. Restaurar reemplaza los datos actuales de Actual y requiere una confirmación explícita; verifica antes la copia y guarda la clave fuera del único archivo de backup.</p>
        <div className="settings-link-row"><a className="button secondary" href="https://github.com/miguel-np/personal-budget/blob/main/docs/backup-restore.md" target="_blank" rel="noreferrer">Leer guía de backup y restore</a></div>
        <p className="setting-hint">El backend no permite borrar un CSV descargado desde el navegador ni incluye una acción general de borrado de Actual. La restauración y los cambios destructivos sobre el presupuesto se hacen mediante el procedimiento documentado, no desde un botón ambiguo.</p>
      </article>
      <article className="panel settings-panel settings-reset-panel">
        <p className="eyebrow">RESTABLECIMIENTO LOCAL</p><h3>Restablecer preferencias de la aplicación</h3>
        <p className="setting-hint">Restablece el tema, el formato regional, la divisa de análisis y el ámbito global de cuentas a sus valores iniciales. No borra movimientos, categorías, presupuestos, datos de Actual, backups ni archivos CSV descargados.</p>
        <button className="button secondary" type="button" disabled={resetting} onClick={onReset}>{resetting ? 'Restableciendo…' : 'Restablecer preferencias locales'}</button>
        {resetError ? <p className="form-alert error" role="alert">{resetError}</p> : null}
        {resetNotice ? <p className="form-alert" role="status">{resetNotice}</p> : null}
      </article>
    </section>
  );
}
