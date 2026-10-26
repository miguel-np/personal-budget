# personal-budget

Aplicación local de finanzas personales con una única interfaz web para gastos, presupuestos, ahorro e informes. Un asistente con IA local será una ampliación opcional.

> **Estado: roadmap P0–P3 completo (25-oct-2026).** La aplicación incluye shell web local, dashboard e informes comparativos, consultas paginadas de movimientos, registro manual, importación CSV con previsualización y conciliación oficial de Actual, presupuestos por categoría, planificación P3 (pagos recurrentes, sugerencias de categoría y previsiones explicables), asistente local con Ollama, MCP de solo lectura y backup/restore verificados. La CI valida Linux y Windows. La aceptación manual de Windows + WSL2 y el ciclo completo de parada/reinicio deben confirmarse en el entorno objetivo; no se consideran demostrados únicamente por CI.

## Arquitectura

- **Actual Budget:** fuente de verdad de cuentas, categorías, presupuestos y movimientos.
- **@actual-app/api:** acceso programático oficial; no se presupone una API REST de Actual.
- **packages/finance-core:** normalización de movimientos y cálculos deterministas con importes en unidades monetarias menores.
- **services/api:** API Fastify local, configuración validada y errores saneados.
- **apps/web:** shell React/Vite con dashboard, movimientos, informes, importación CSV y edición de presupuestos en una sola interfaz local.
- **Ollama y MCP:** asistente local opcional conectado a la interfaz y servidor MCP de solo lectura por stdio, validados con `qwen3:8b`.

## Requisitos

- Windows + WSL2 (Ubuntu recomendado).
- Docker/Compose.
- Node.js 24.22.1 Active LTS y npm compatible.

Consulta [baseline de versiones y política de auditoría](docs/version-baseline.md). Ninguna selección de versiones garantiza ausencia permanente de vulnerabilidades; CI ejecuta auditorías sobre el árbol de dependencias.

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

Abre http://127.0.0.1:4173. El comando compila y administra la API y el frontend compilado; Ctrl+C detiene ambos procesos. Si Actual no está preparado o Ollama está desactivado, la shell muestra el estado sin ocultar la incidencia. Ejecuta `npm run doctor` para revisar requisitos sin mostrar secretos.

## Desarrollo local

Desde WSL, en la raíz del repositorio:

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

Abre http://127.0.0.1:5173. La aplicación incluye Resumen, Movimientos, Informes, Presupuestos, Planificación, Asistente y Configuración. Configura ACTUAL_BUDGET_ID con el Sync ID del presupuesto de Actual. En Movimientos puedes registrar un movimiento o importar CSV; ambas operaciones muestran una previsualización y exigen confirmar antes de escribir en Actual. Planificación detecta pagos recurrentes, sugiere categorías con confirmación y simula escenarios explicables. El Asistente es opcional (AI_ENABLED/OLLAMA_MODEL en .env) y funciona con Ollama local.

## Prueba opcional con un presupuesto de Actual existente

Para probar la API oficial contra un presupuesto local de prueba sin modificar transacciones, sigue [la guía de instalación](docs/installation.md#9-prueba-de-aceptación-con-un-presupuesto-local-existente-opcional). Esa prueba se omite en CI si no se habilita explícitamente y no usa datos financieros en pipelines normales.

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

### Comprobar parada limpia del runtime

En WSL2, con los puertos locales 3000 y 4173 libres, ejecuta una comprobación sintética del runtime compilado. No necesita conectar un presupuesto real ni escribir datos financieros:

~~~bash
cp .env.example .env
npm ci
npm run build
npm run test:runtime:lifecycle
rm .env
~~~

La prueba verifica que la UI y la API arrancan, que readiness comunica el estado `not_configured`, que el runtime termina tras `SIGTERM` y que los endpoints dejan de responder. No sustituye la validación de reinicios de Windows/WSL2 ni verifica por sí sola todas las variantes de cierre de terminal.

## Privacidad

No se configura sincronización bancaria automática ni se requieren credenciales bancarias. Actual Budget y la API se vinculan a localhost; Ollama será local por defecto cuando se integre. Las pruebas usan datos sintéticos. No subas .env, extractos, bases de datos financieras, logs sensibles, modelos ni copias de seguridad a Git.

La ejecución local reduce la exposición externa, pero no elimina los riesgos de malware, acceso del sistema operativo ni conexiones necesarias para descargar dependencias o actualizaciones. Consulta [privacidad](docs/privacy.md) y [seguridad](SECURITY.md).

## Documentación

- [Índice](docs/index.md)
- [Instalación WSL2](docs/installation.md)
- [Arquitectura](docs/architecture.md)
- [Estado de implementación](docs/implementation-status.md)
- [Roadmap](docs/roadmap.md)
- [Desarrollo](docs/development.md)
- [Licencia](docs/licensing.md)

## Licencia

El código y la documentación originales están bajo MIT. Los datos financieros del usuario no forman parte de esta licencia; las dependencias, componentes y modelos de terceros conservan sus propias licencias.
