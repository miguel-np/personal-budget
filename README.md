# personal-budget

Aplicación local-first de finanzas personales basada en Actual Budget, con una interfaz web única para cuentas, movimientos, presupuestos, planificación, inteligencia financiera, patrimonio y documentación.

> **Estado a 1 de noviembre de 2026:** las fases de consolidación, inteligencia financiera útil y gestión patrimonial/portabilidad están integradas en `main`. Incluyen backup cifrado unificado (Actual + estado propio), aceptación manual Windows + WSL2, flujo de caja, propuestas y alertas, exportación PDF/XLSX, activos y pasivos externos, justificantes vinculados, exportación portable y contratos financieros neutrales respecto del proveedor. El desacoplamiento preventivo de #65 también está integrado. Las dos iteraciones de búsqueda web controlada de #84 están integradas mediante PR [#97](https://github.com/miguel-np/personal-budget/pull/97) y [#98](https://github.com/miguel-np/personal-budget/pull/98): flujo separado, consentimiento por consulta, búsqueda acotada y recuperación de documentos oficiales con evidencia temporal BOE. No habilita acceso general del modelo a Internet ni comparte contexto financiero. La issue sigue abierta para aceptación real con organismos, PDF y verificación jurídica avanzada.

## Capacidades

- **Finanzas diarias:** dashboard, cuentas, categorías, alta/edición de movimientos, transferencias, splits, presupuestos e informes comparativos.
- **Importación y exportación:** CSV y OFX local con previsualización; exportaciones de movimientos e informes a CSV, JSON, PDF imprimible y XLSX.
- **Planificación:** pagos recurrentes candidatos, sugerencias híbridas de categoría con reglas e IA local optativa, previsiones, objetivos, compromisos, planificador conversacional y escenarios.
- **Inteligencia financiera:** hallazgos verificables, anomalías, revisión semanal/mensual, flujo de caja estimado, propuestas presupuestarias simulables y alertas locales.
- **Patrimonio y justificantes:** activos y pasivos externos, valoraciones manuales fechadas, clasificación explícita de cuentas de Actual, documentos privados y vínculos comprobados a movimientos.
- **Portabilidad y recuperación:** exportación legible de conjuntos locales y backup/restauración cifrados de Actual más el estado propio inventariado.
- **IA y herramientas locales:** Ollama opcional, MCP de solo lectura por stdio y búsqueda web explícita mediante SearXNG configurable. La investigación puede recuperar hasta tres documentos oficiales HTML/texto; para BOE-A consulta metadatos temporales/relaciones y muestra límites de vigencia. No interpreta PDF ni emite dictámenes legales.

## Arquitectura

- **Actual Budget:** fuente de verdad de cuentas, categorías, presupuestos y movimientos.
- **`services/actual-adapter`:** frontera única del SDK oficial `@actual-app/api` y mapeo de estructuras/errores del proveedor.
- **`packages/finance-core`:** contratos de dominio neutrales, normalización y cálculos deterministas con importes en unidades monetarias menores.
- **`services/api`:** API Fastify local; valida ámbito, configuración, persistencia local, límites y errores.
- **`apps/web`:** shell React/Vite con paneles cargados bajo demanda.
- **Estado propio:** almacenes versionados para preferencias, planificación, decisiones, revisiones, patrimonio y metadata documental; los binarios de justificantes se custodian fuera del directorio público.
- **Ollama:** inferencia local opcional. El asistente financiero recibe agregados calculados en backend y no tiene herramientas.
- **Búsqueda web:** la API ejecuta una única herramienta `web_search` sobre el texto exacto que el usuario autoriza. SearXNG puede ser local o remoto por HTTPS. Tras buscar, recupera como máximo tres documentos oficiales desde una allowlist HTTPS; para normas BOE-A obtiene metadatos y relaciones temporales. No consulta movimientos, cuentas ni agregados; resultados y textos externos se tratan como contenido no confiable.
- **MCP:** servidor independiente, solo lectura y por stdio.

## Requisitos

- Windows + WSL2 (Ubuntu recomendado).
- Docker/Compose.
- Node.js 24.22.1 Active LTS y npm compatible.

Consulta [baseline de versiones y política de auditoría](docs/version-baseline.md). Las versiones fijadas facilitan instalaciones reproducibles, pero no garantizan ausencia permanente de vulnerabilidades.

## Uso diario (frontend compilado)

Desde WSL, en la raíz del repositorio:

~~~bash
nvm install
nvm use
npm ci
cp .env.example .env
mkdir -p .local/actual-server-data .local/actual-api .local/backups
docker compose up -d actual
npm run doctor
npm run start:local
~~~

Abre http://127.0.0.1:4173. El comando compila la aplicación, inicia la API y sirve el frontend compilado; Ctrl+C coordina el cierre. `npm run doctor` revisa requisitos y servicios sin mostrar secretos.

## Desarrollo local

~~~bash
nvm install
nvm use
npm ci
cp .env.example .env
mkdir -p .local/actual-server-data .local/actual-api .local/backups
docker compose up -d
npm run dev:api
~~~

En otra terminal WSL:

~~~bash
npm run dev:web
~~~

Abre http://127.0.0.1:5173. La aplicación incluye Resumen, Movimientos, Cuentas, Patrimonio y documentos, Informes, Presupuestos, Planificación, Inteligencia financiera, Revisión financiera, Objetivos, Asistente y Configuración. Configura `ACTUAL_BUDGET_ID` con el Sync ID del presupuesto de Actual.

En Movimientos, el registro y las importaciones CSV/OFX requieren previsualización y confirmación antes de escribir en Actual. OFX admite perfiles SGML 1.02/1.03 y XML OFX 2.x delimitados; consulta [la guía OFX](docs/ofx-import.md). Planificación diferencia recurrencias confirmadas de candidatos estimados. Las alertas presupuestarias son locales e in-app; no hay daemon ni notificaciones del sistema operativo.

El asistente de Ollama está desactivado por defecto (`AI_ENABLED=false`). La búsqueda externa tiene otro interruptor (`WEB_SEARCH_ENABLED=false`) y, además, requiere consentimiento explícito para cada consulta. Consulta [IA local](docs/local-ai.md) y [búsqueda web](docs/web-search.md).

## Prueba con un presupuesto de Actual existente

Para probar el adaptador oficial contra un presupuesto local de prueba sin modificar transacciones, sigue la [guía de instalación](docs/installation.md#9-prueba-de-aceptación-con-un-presupuesto-local-existente-opcional). La aceptación live se omite en CI salvo habilitación explícita y utiliza presupuestos sintéticos.

## Calidad

~~~bash
npm run doctor
npm run test:e2e
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run audit
npm run audit:production
~~~

La CI ejecuta además aceptación sintética contra Actual aislado, pruebas de navegador, calidad Windows y escaneo de seguridad. La aceptación manual Windows + WSL2 de #31 se registró el 1-nov-2026; una instalación nueva debe repetir su propia matriz.

## Privacidad

No se configura sincronización bancaria automática ni se requieren credenciales bancarias. Actual Budget y la API se vinculan a localhost; Ollama es local cuando se habilita. La búsqueda web permanece desactivada por defecto y exige consentimiento por petición. SearXNG recibe únicamente el texto confirmado, no conversaciones ni datos financieros. Para resultados oficiales admitidos, el backend puede realizar hasta tres peticiones de lectura a los organismos enlazados; esos organismos ven la IP pública de salida del servidor y la URL consultada. Un SearXNG autohospedado puede remitir la consulta a sus motores upstream según su configuración. Lee [privacidad](docs/privacy.md), [seguridad](SECURITY.md) y [búsqueda web](docs/web-search.md).

No subas `.env`, extractos, bases de datos financieras, logs sensibles, modelos ni copias de seguridad a Git.

## Documentación

- [Índice completo](docs/index.md)
- [Instalación Windows + WSL2](docs/installation.md)
- [Arquitectura](docs/architecture.md)
- [Estado de implementación](docs/implementation-status.md)
- [Roadmap](docs/roadmap.md)
- [Configuración](docs/configuration.md)
- [Privacidad](docs/privacy.md)
- [Backup y restauración](docs/backup-restore.md)
- [Patrimonio, justificantes y portabilidad](docs/wealth-and-evidence.md)
- [Exportación PDF/XLSX/CSV/JSON](docs/export-formats.md)

## Licencia

El código y la documentación originales están bajo MIT. Los datos financieros del usuario no forman parte de esta licencia; las dependencias, componentes, modelos y servicios de terceros conservan sus propias licencias.
