# Desarrollo

## Estado actual

El repositorio contiene una aplicación local React/Vite, API Fastify, adaptador oficial de Actual, cálculos deterministas, importación CSV con confirmación, presupuestos por categoría, informes, planificación y asistente local opcional. El modo de uso diario y las pruebas de navegador se ejecutan sobre el frontend compilado. La suite sintética no sustituye la aceptación manual específica de Windows + WSL2.

## Entorno

- Windows + WSL2, Ubuntu recomendado.
- Node.js 24.22.1 y npm compatibles.
- Docker/Compose para Actual Budget.
- Ollama solo para una fase futura; no es requisito de los tests normales.

Mantén el código dentro del filesystem Linux de WSL. Nunca uses datos personales reales en fixtures o ejemplos.

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

## Comandos

~~~bash
npm ci
npm run doctor
npm run start:local
~~~

El uso diario compila y sirve la aplicación en `127.0.0.1:4173`, con API en `127.0.0.1:3000`. Ctrl+C detiene ambos procesos. No se requieren comandos de desarrollo ni Ollama para las funciones financieras básicas. Usa `npm run dev:api` y `npm run dev:web` únicamente para desarrollo con recarga en caliente.


~~~bash
npm ci
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run audit
npm run audit:production
npm run dev:api
npm run dev:web
~~~

## Pruebas mínimas

- Cálculos exactos en unidades monetarias menores.
- Límites de mes/año y años bisiestos.
- Transferencias internas excluidas del gasto consolidado.
- Reembolsos, categorías ausentes, importes extremos y transacciones divididas.
- Validación del adaptador y ciclo de vida.
- Configuración que prohíbe hosts y URLs remotos.
- Errores de API saneados y límites de parámetros.
- Integración contra una instancia de Actual con datos sintéticos.
- Auditoría de dependencias y revisión de secretos en CI.

La suite ordinaria no debe necesitar credenciales, banco real, Internet ni un modelo real. Las pruebas de aceptación de Ollama/Actual pueden ser optativas, pero necesarias antes de afirmar que la integración está validada.

## Clean Code y SOLID

Las rutas HTTP dependen de la interfaz BudgetRepository, no de Actual directamente. El núcleo financiero no depende del framework web, de Actual ni de IA. El adaptador encapsula el ciclo de vida y serializa el uso de la API de Actual. Los cambios de contrato deben incluir pruebas y documentación. Prioriza funciones pequeñas, nombres explícitos, validación en fronteras y abstracciones justificadas.

## Prueba opcional contra Actual Budget real

La suite unitaria usa un contrato inyectable para que CI no necesite un presupuesto real. Para demostrar la compatibilidad con el servidor y API fijados, prepara un presupuesto local de prueba y sigue el comando de [instalación](installation.md#7-prueba-de-aceptación-con-un-presupuesto-local-existente-opcional). La prueba es de solo lectura y no debe usar un presupuesto con datos sensibles para CI o capturas.



## Pruebas E2E de navegador

~~~bash
npm run build
npx playwright install chromium
npm run test:e2e
~~~

La suite se ejecuta en Chromium contra el frontend compilado y una API de fixtures sintéticos; no accede al presupuesto local, backups ni Ollama. Consulta [Pruebas de navegador](browser-testing.md) y [Sistema de diseño](design-system.md).
