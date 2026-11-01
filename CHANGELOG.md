# Changelog

## Unreleased

- Añadido el centro de inteligencia financiera de la issue #68: hallazgos deterministas versionados, comparaciones de periodos equivalentes, prioridad explicada, revisión persistente, filtros, evidencia, IA local opcional y pruebas unitarias/API/E2E.

- Añadido workspace npm/TypeScript con núcleo financiero, adaptador de Actual Budget, API local y shell web.
- Añadido núcleo financiero determinista con importes en unidades menores, validación de fechas, exclusión de transferencias y normalización de transacciones divididas.
- Añadido adaptador inyectable para la API oficial de Actual, operaciones serializadas y dry-run por defecto para importaciones.
- Añadida API Fastify local con validación de configuración, host loopback, controles de Origin, respuestas saneadas y endpoints de lectura.
- Añadida shell React/Vite que comprueba el estado del backend; el dashboard completo queda pendiente.
- Añadido Compose con versión fijada de Actual Budget y puerto limitado a localhost.
- Añadidas pruebas unitarias y de API, política de cobertura y CI para auditoría, lint, typecheck y build.
- Añadido smoke test de Docker para validar la configuración y el arranque del servidor Actual Budget 26.10.0 en localhost.
- CI verde: 40 pruebas aprobadas, 1 prueba live opcional omitida, cobertura global del 94,5 % de sentencias, 86,02 % de ramas y 96,1 % de líneas; `npm audit` y auditoría de dependencias de producción reportan cero vulnerabilidades conocidas.
- Añadido lockfile npm inicial por CI.
- Pendiente: validar resultados de CI, probar adaptador contra Actual local y completar funciones del producto en P1.

- Integrada en `main` (commit `9164741`) la fase 2 de inteligencia financiera: proyección de flujo de caja local con estados de conciliación disponibles, propuestas/simulaciones presupuestarias que respetan categorías protegidas y alertas in-app configurables (#73, #83, #74). El almacén `financial-actions.json` forma parte del backup cifrado unificado.

- Ampliado el benchmark de paginación de movimientos (#28): datasets de mes denso y multi-cuenta, pico de heap muestreado durante la petición con máximo entre repeticiones y recorrido completo de páginas sin omisiones ni duplicados con fechas/importes idénticos, splits y filtros. La evaluación de ActualQL y los efectos de cambios concurrentes entre páginas quedan documentados en docs/transactions-and-imports.md.
