# Changelog

Este documento conserva el historial de cambios del producto. El estado de issues, el roadmap y las limitaciones de aceptación se mantienen en [GitHub Issues](https://github.com/miguel-np/personal-budget/issues), [Estado de implementación](docs/implementation-status.md) y [Roadmap](docs/roadmap.md), no aquí.

## [Unreleased]

### Added
- Política explícita de alcance y criterios de entrada/salida para nuevas capacidades.
- Presupuestos de tamaño y plan incremental de modularización para los módulos de API y web.
- Plantillas estructuradas de issues y PR, y declaración de CODEOWNERS.
- Evidencia fechada de CI, cobertura y auditorías de seguridad; política de contribución con comandos reales y uso de correo GitHub noreply.

### Changed
- El runtime de desarrollo, CI y diagnóstico pasa a Node.js 26.13.1 Active LTS con npm 11.20.0; se actualizan los tipos de Node y los requisitos de instalación.
- Actual Budget server y `@actual-app/api` pasan conjuntamente a 26.11.0, con aceptación sintética de integridad financiera y recuperación.
- Se actualizan Vitest y `@vitest/coverage-v8` a 5.1.1 y Playwright Test a 1.65.1; se alinea el árbol transitivo del runner y del proveedor de cobertura.
- Se actualiza ESLint a 10.15.0, `@eslint/config-array` a 0.23.6 y `minimatch` a 11.0.9, alineando el matcher transitivo con los requisitos de la release y las correcciones de seguridad publicadas.
- El README y el roadmap dejan de duplicar el estado operativo de GitHub.
- Reorganizada la documentación de estado y el inventario documental para distinguir implementación, evidencia automatizada y aceptación externa/manual.

## Historial heredado (entradas sin versión asignada)

### Added
- Workspace npm/TypeScript con núcleo financiero, adaptador de Actual Budget, API local y shell web.
- Núcleo financiero determinista con importes en unidades menores, validación de fechas, exclusión de transferencias y normalización de transacciones divididas.
- Adaptador inyectable para la API oficial de Actual, operaciones serializadas y previsualización antes de escribir importaciones.
- API Fastify local con validación de configuración, host loopback, controles de Origin, respuestas saneadas y endpoints de lectura.
- Shell React/Vite y Compose con versión fijada de Actual Budget y puerto limitado a localhost.
- Pruebas unitarias y de API, política de cobertura, CI de auditoría/lint/typecheck/build, smoke test de Docker para Actual y lockfile npm.
- Centro de inteligencia financiera: hallazgos deterministas versionados, comparaciones de periodos equivalentes, prioridad explicada, revisión persistente, filtros, evidencia e IA local opcional.
- Proyección local de flujo de caja, propuestas y simulaciones presupuestarias, y alertas in-app configurables (#73, #83 y #74).

### Changed
- Benchmark de paginación de movimientos ampliado con datasets densos y multicuentas, muestreo de heap y recorrido de páginas sin omisiones ni duplicados en conjuntos estáticos. Los límites de ActualQL y los efectos de cambios concurrentes entre páginas se documentan en [transacciones e importaciones](docs/transactions-and-imports.md).

Las entradas heredadas se han conservado sin asignarles una fecha o versión que no estaba respaldada por el historial disponible.
