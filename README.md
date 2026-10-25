# personal-budget

Aplicación local de finanzas personales con una única interfaz web para gastos, presupuestos, ahorro e informes. Un asistente con IA local será una ampliación opcional.

> **Estado: base técnica P0 añadida; validación de CI e integración real pendientes.** El repositorio contiene un workspace TypeScript, núcleo financiero, adaptador para Actual Budget, API local y una shell React/Vite provisional. El MVP de movimientos e informes todavía no está completo.

## Arquitectura

- **Actual Budget:** fuente de verdad de cuentas, categorías, presupuestos y movimientos.
- **@actual-app/api:** acceso programático oficial; no se presupone una API REST de Actual.
- **packages/finance-core:** normalización de movimientos y cálculos deterministas con importes en unidades monetarias menores.
- **services/api:** API Fastify local, configuración validada y errores saneados.
- **apps/web:** shell React/Vite provisional; dashboard y funciones completas serán P1.
- **Ollama y MCP:** fase posterior, aún no conectados a la interfaz.

## Requisitos

- Windows + WSL2 (Ubuntu recomendado).
- Docker/Compose.
- Node.js 24.22.1 Active LTS y npm compatible.

Consulta [baseline de versiones y política de auditoría](docs/version-baseline.md). Ninguna selección de versiones garantiza ausencia permanente de vulnerabilidades; CI ejecuta auditorías sobre el árbol de dependencias.

## Inicio local

Desde WSL, en la raíz del repositorio:

~~~bash
nvm install
nvm use
npm ci
cp .env.example .env
docker compose up -d
npm run dev:api
~~~

En otra terminal WSL:

~~~bash
npm run dev:web
~~~

Abre http://127.0.0.1:5173. La shell actual solo comprueba el estado de la API; el dashboard, registro manual, importación desde la app e informes completos se implementarán en P1. Configura ACTUAL_BUDGET_ID con el Sync ID del presupuesto de Actual.

## Calidad

~~~bash
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run audit
npm run audit:production
~~~

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
