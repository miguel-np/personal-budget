# Inventario de documentación

Inventario de guías y documentos versionados. La navegación de usuario comienza en `docs/index.md`. La autoridad de estado se divide entre el ciclo de vida de GitHub y la evidencia técnica de [implementation-status.md](docs/implementation-status.md).

## Raíz

- README.md — resumen, capacidades, arquitectura, inicio y enlaces de referencia.
- CHANGELOG.md — historial de cambios agrupado por versión o estado de publicación.
- CONTRIBUTING.md — normas de contribución, validación e identidad de commits.
- SECURITY.md — política de seguridad y evidencia fechada de controles.
- SUPPORT.md — soporte.
- CODE_OF_CONDUCT.md — conducta.
- CODEOWNERS — responsabilidad de revisión por rutas.
- LICENSE — licencia del código original.

## Documentación funcional y técnica

- docs/index.md — índice de guías.
- docs/architecture.md — arquitectura, límites y flujos de datos.
- docs/maintainability.md — presupuestos de tamaño, modularización y deuda técnica.
- docs/scope-policy.md — criterios de entrada/salida, clasificación experimental y taxonomía del backlog.
- docs/installation.md — instalación local Windows + WSL2 y aceptación.
- docs/configuration.md — variables de entorno validadas por la aplicación.
- docs/version-baseline.md — versiones fijadas y política de auditoría.
- docs/development.md — estructura, comandos y pruebas.
- docs/implementation-status.md — baseline de capacidades verificadas, evidencias y límites.
- docs/roadmap.md — dirección estratégica y secuencia de decisiones; no sustituye el backlog.
- docs/transactions-and-imports.md — importación, exportación y rendimiento de historiales.
- docs/api-performance.md — rendimiento transversal y carga sintética del API.
- docs/ofx-import.md — perfiles, codificaciones, conciliación y seguridad OFX.
- docs/account-scope.md — ámbito global de cuentas.
- docs/multi-currency.md — divisas, conversiones y trazabilidad.
- docs/planning.md — recurrentes, clasificación híbrida y previsiones.
- docs/planning-goals.md — objetivos de ahorro y compromisos.
- docs/financial-intelligence.md — hallazgos, anomalías, evidencia y revisión.
- docs/periodic-financial-review.md — contrato de revisión semanal/mensual.
- docs/cash-flow.md — proyección de flujo de caja y límites.
- docs/budget-improvements.md — propuestas y simulaciones presupuestarias.
- docs/budget-alerts.md — alertas locales configurables.
- docs/wealth-and-evidence.md — activos/pasivos externos, justificantes y exportación portable.
- docs/export-formats.md — contratos de exportación PDF/XLSX/CSV/JSON.
- docs/provider-contracts.md — contratos financieros neutrales y suite de conformidad.
- docs/local-ai.md — Ollama, límites, privacidad y planificador conversacional.
- docs/web-search.md — búsqueda externa controlada, SearXNG, fuentes oficiales y límites fiscales.
- docs/legal-tax-corpus.md — casos de regresión fiscal, clasificación de fuentes, snapshots y revisión humana.
- docs/mcp.md — transporte stdio y permisos MCP.

## Privacidad y operación

- docs/privacy.md — privacidad y flujos de datos externos.
- docs/backup-restore.md — backup/restore cifrado unificado.
- docs/operations.md — operación local.
- docs/safe-updates.md — actualización segura y rollback.
- docs/troubleshooting.md — resolución de problemas.
- docs/p2-acceptance.md — criterios y resultados de aceptación P2.
- docs/browser-testing.md — estrategia de pruebas E2E de navegador.
- docs/design-system.md — sistema de diseño.
- docs/licensing.md — licencias de terceros y datos del usuario.
- docs/usage.md — guía de uso.
- docs/update-compatibility.json — matriz de compatibilidad de actualización.

## Decisiones

- docs/decisions/0001-local-first.md — decisión local-first.
- docs/decisions/0002-actual-budget.md — Actual Budget como fuente de verdad.
- docs/decisions/0003-mcp-permissions.md — límites y permisos MCP.
- docs/decisions/0004-actual-budget-dependency.md — decisión sobre Actual Budget, consultas, contratos neutrales y criterios de reconsideración.

## Plantillas y gobierno de contribución

- .github/ISSUE_TEMPLATE/bug_report.yml — reporte de errores con reproducción sintética.
- .github/ISSUE_TEMPLATE/feature_request.yml — propuesta de nueva capacidad y sus controles.
- .github/ISSUE_TEMPLATE/refinement.yml — refinamiento de una capacidad existente.
- .github/PULL_REQUEST_TEMPLATE.md — alcance, riesgo, privacidad y validación de cambios.
