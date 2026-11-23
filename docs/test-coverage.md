# Alcance de cobertura automatizada

## Vitest y cobertura V8

`npm run test:coverage` ejecuta Vitest con el proveedor V8. El informe incluye únicamente los archivos declarados explícitamente en `vitest.config.ts` y realmente ejecutados dentro del proceso de Vitest:

- `packages/finance-core/src/**/*.ts`
- `services/actual-adapter/src/**/*.ts`
- `services/api/src/**/*.ts`
- `services/mcp/server.mjs`
- `apps/web/src/csv-import.ts`
- `apps/web/src/export-utils.ts`
- `apps/web/src/finance-format.ts`
- `apps/web/src/financial-signals.ts`
- `apps/web/src/ofx-import.ts`
- `scripts/runtime-checks.ts`
- `scripts/dev-supervisor.mjs`

Se excluyen los entrypoints `**/index.ts` y `**/main.ts`. La lista es deliberadamente explícita: no incluye automáticamente todos los componentes React, scripts CLI, ficheros de configuración ni código que no se ejercita desde Vitest.

El protocolo MCP dispone de dos niveles complementarios. Las pruebas con el cliente oficial y el transporte stdio conservan la verificación de interoperabilidad en procesos separados. Además, `createMcpHandler()` permite ejecutar la lógica JSON-RPC/herramientas directamente en Vitest; ese camino sí contribuye a la cobertura V8 del proceso de pruebas. El entrypoint `npm run mcp:serve` conserva el arranque stdio y solo se activa al ejecutar `services/mcp/server.mjs` directamente.

## Suites que no forman parte del porcentaje Vitest

- Las pruebas Playwright (`npm run test:e2e`) validan comportamiento renderizado, navegación, responsive, accesibilidad y flujos de navegador. No se presentan como cobertura de líneas.
- Algunas pruebas de scripts utilizan el ejecutor nativo `node:test` y se ejecutan por separado en CI: `scripts/local-acceptance-origin.test.mjs`, `scripts/quality/repository-checks.test.mjs` y las pruebas `scripts/web-search-live-acceptance-*.test.mjs`. No se incluyen en el porcentaje Vitest.
- Las pruebas opt-in/live contra proveedores o servicios externos no se ejecutan como parte de la cobertura ordinaria.

## Umbrales y lectura del informe

Se mantienen los umbrales globales de Vitest:

| Métrica | Umbral |
|---|---:|
| Statements | 80 % |
| Branches | 75 % |
| Functions | 80 % |
| Lines | 80 % |

El umbral se aplica al conjunto de archivos instrumentados, no certifica cada módulo individual. Para módulos de riesgo crítico deben revisarse también los casos y ramas cubiertos; una cifra global alta no compensa una ruta crítica sin pruebas.

El workflow CI publica `coverage/lcov.info`, `coverage/coverage-summary.json` y el informe HTML como artefacto temporal. Para citar métricas hay que indicar el SHA y el run de CI que las generó. No se deben copiar valores históricos como si fueran actuales.

La cobertura mide ejecución, no corrección exhaustiva, seguridad demostrada ni conformidad WCAG. Para seguridad se mantienen además CodeQL, auditorías de dependencias, análisis de secretos y revisión específica. Para la UI se mantienen las pruebas E2E y las verificaciones manuales descritas en [pruebas de navegador](browser-testing.md).
