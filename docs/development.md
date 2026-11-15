# Desarrollo

## Entorno

- Windows + WSL2, Ubuntu recomendado.
- Node.js 24.22.1 y npm compatibles.
- Docker/Compose para Actual Budget.
- Ollama es opcional; no es requisito de las pruebas normales.
- Mantén el código y las instalaciones de desarrollo dentro del filesystem Linux de WSL. No uses datos financieros reales en fixtures o ejemplos.

## Estructura

~~~text
personal-budget/
├── apps/web/                 # React/Vite shell
├── services/api/             # Fastify local
├── services/actual-adapter/  # adaptador @actual-app/api
├── packages/finance-core/    # tipos y cálculos puros
├── docs/
└── compose.yaml
~~~

## Uso diario

~~~bash
npm ci
npm run doctor
npm run start:local
~~~

El uso diario compila y sirve la aplicación en `127.0.0.1:4173`, con API en `127.0.0.1:3000`. Ctrl+C detiene ambos procesos. No se requieren comandos de desarrollo ni Ollama para las funciones financieras básicas.

Para desarrollo con recarga en caliente, ejecuta `npm run dev:api` y `npm run dev:web` en terminales separadas.

## Validación

Desde la raíz del repositorio y con Node.js 24.22.1:

~~~bash
npm ci
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run audit
npm run audit:production
npm run test:e2e
~~~

Para E2E en un entorno sin Chromium:

~~~bash
npm run build
npx playwright install chromium
npm run test:e2e
~~~

La suite Playwright se ejecuta contra el frontend compilado y una API con fixtures sintéticas; no accede al presupuesto local, backups ni Ollama. Consulta [pruebas de navegador](browser-testing.md) y [sistema de diseño](design-system.md).

## Pruebas mínimas según el cambio

- Cálculos exactos en unidades monetarias menores, límites de mes/año y años bisiestos.
- Transferencias internas excluidas del gasto consolidado, reembolsos, categorías ausentes, importes extremos y transacciones divididas.
- Validación del adaptador, ciclo de vida y errores del proveedor.
- Configuración que prohíbe hosts y URLs remotos cuando no están permitidos.
- Errores de API saneados, límites de parámetros y autorización del ámbito.
- Escrituras con previsualización, confirmación, idempotencia y recuperación ante fallo.
- Integración contra una instancia aislada de Actual con datos sintéticos cuando se toque el adaptador, update o backup.
- Auditoría de dependencias y escaneo de secretos en CI.
- E2E de navegador y comprobaciones manuales de teclado, responsive y lector de pantalla cuando el cambio afecte UI.

La suite ordinaria no debe necesitar credenciales, banco real, Internet ni un modelo real. Las aceptaciones live de Ollama/Actual/SearXNG pueden ser optativas, pero necesarias antes de afirmar que esa integración real está validada.

## Clean Code y SOLID

Las rutas HTTP dependen de la interfaz `BudgetRepository`, no de Actual directamente. El núcleo financiero no depende del framework web, de Actual ni de IA. El adaptador encapsula el ciclo de vida y serializa el uso de la API de Actual. Los cambios de contrato deben incluir pruebas y documentación. Prioriza funciones pequeñas, nombres explícitos, validación en fronteras y abstracciones justificadas.

Consulta [mantenibilidad](maintainability.md) antes de extraer o crear módulos grandes.

## Prueba opcional contra Actual Budget

La suite unitaria usa un contrato inyectable para que CI no necesite un presupuesto real. Para demostrar compatibilidad con el servidor y API fijados, prepara un presupuesto local de prueba y sigue el procedimiento de [instalación](installation.md#9-prueba-de-aceptación-con-un-presupuesto-local-existente-opcional). La prueba es de solo lectura y no debe usar un presupuesto con datos sensibles para CI o capturas.
