# Estado de implementación

**Snapshot de referencia:** 15-nov-2026, `main` en `98bdbb270101116f1fb5fe032101e78558c63035`, anterior a la intervención documental de #126.

Este documento registra capacidades integradas y evidencia técnica fechada. El ciclo de vida de issues y PR es autoritativo en GitHub; no se replica aquí una lista exhaustiva del backlog. El [README](../README.md) resume el producto y el [roadmap](roadmap.md) describe la dirección estratégica.

## Estado técnico verificado

| Área | Estado observado | Alcance y límite |
|---|---|---|
| Núcleo financiero | Integrado | Actual Budget conserva la fuente de verdad; `finance-core` contiene contratos neutrales y cálculos deterministas. |
| Gestión diaria | Integrada | Dashboard, cuentas, movimientos, divisiones, transferencias, presupuestos e informes. |
| Importación | Integrada | CSV y OFX local con previsualización y confirmación; los perfiles admitidos están delimitados en la guía OFX. |
| Multidivisa | Integrada | Divisas y tipos de cambio manuales fechados; no hay cotizaciones automáticas. |
| Planificación | Integrada | Recurrencias candidatas, sugerencias híbridas, previsiones, objetivos, compromisos y simulación conversacional. |
| Inteligencia financiera | Integrada | Hallazgos, anomalías, revisiones, flujo de caja, propuestas y alertas locales. |
| Patrimonio y documentos | Integrada | Activos/pasivos externos, valoraciones manuales, documentos privados y vínculos verificados. |
| Backup y portabilidad | Integrada | Backup cifrado de Actual más almacenes propios y binarios documentales inventariados; exportación portable no equivale a backup restaurable. |
| IA y MCP | Integradas como capacidades opcionales | Ollama local; el chat financiero no tiene herramientas. MCP stdio ofrece herramientas financieras agregadas de lectura/simulación no persistente y prompts reutilizables. |
| Investigación web #84 | Código integrado; aceptación incompleta | Consentimiento por petición, SearXNG aislado del contexto financiero, recuperación oficial acotada, allowlist exacta y controles SSRF/DNS. No constituye dictamen jurídico. |

Consulta [arquitectura](architecture.md), [privacidad](privacy.md), [backup](backup-restore.md), [web search](web-search.md) y los contratos funcionales para los detalles técnicos de cada dominio.

## Evidencia automatizada fechada

En el commit de referencia `98bdbb2`, el CI y Security finalizaron correctamente:

| Check | Resultado |
|---|---|
| `quality` | Success |
| `browser-e2e` | Success |
| `actual-container-smoke` | Success |
| `windows-quality` | Success |
| `actual-update-acceptance` | Success |
| `dependency-and-secret-scan` | Success |

- [CI run 43718412265](https://github.com/miguel-np/personal-budget/actions/runs/43718412265).
- [Security run 43718412220](https://github.com/miguel-np/personal-budget/actions/runs/43718412220).
- En esa ejecución, `npm audit` y `npm audit --omit=dev` encontraron cero vulnerabilidades conocidas en las bases consultadas; Gitleaks no encontró secretos en el cambio escaneado.
- Cobertura global observada: 86,59 % statements, 76,67 % branches, 90,50 % functions y 90,73 % lines. Los umbrales configurados son 80/75/80/80. Ver [política de seguridad](../SECURITY.md) para alcance y límites.

La evidencia anterior no debe extrapolarse a commits posteriores. Para decidir si una PR está validada, consulta los checks de su último SHA, no el estado de otra ejecución.

## Aceptación externa o manual pendiente

| Capacidad / issue | Estado técnico | Condición que falta |
|---|---|---|
| [#84 — Investigación web controlada](https://github.com/miguel-np/personal-budget/issues/84) | Código y primeras pruebas integrados | No cerrar hasta resolver los bloqueos independientes indicados abajo. |
| [#106 — Aceptación E2E de SearXNG y fuentes oficiales](https://github.com/miguel-np/personal-budget/issues/106) | Procedimiento opt-in documentado | Ejecutar localmente con API en loopback, SearXNG configurado y fuentes oficiales; revisar tráfico y logs reales. No requiere ni debe exigir un backend público. |
| [#108 — Corpus fiscal/legal](https://github.com/miguel-np/personal-budget/issues/108) | Corpus provisional de 13 casos y regresiones deterministas integrados | Revisión y aprobación humana competente de cada resultado esperado. |
| [#110 — Evidencia y discrepancias](https://github.com/miguel-np/personal-budget/issues/110) | Cotejo literal, clasificación y comparación descriptiva integrados | Validación semántica independiente, revisión de soporte por afirmación y de discrepancias no señaladas por el modelo. |

La coincidencia literal de una cita acredita la presencia del fragmento recuperado, no que implique semánticamente la afirmación. La comparación de metadatos no resuelve jerarquía, rango, jurisdicción, aplicabilidad ni régimen transitorio. Estos límites se mantienen explícitos; CI verde no equivale a aprobación jurídica.

## Gobernanza del repositorio — snapshot auditado

- `main` no tenía protección efectiva al consultar el endpoint de rama (`protected=false`).
- El endpoint de rulesets del repositorio devolvió una lista vacía. La consulta detallada de protección clásica devolvió 403; no se pudo comprobar si existen políticas heredadas u otro control fuera del repositorio.
- El repositorio no tenía etiquetas de prioridad/área aplicadas al backlog abierto. La taxonomía se documenta en [scope-policy.md](scope-policy.md), pero su creación y aplicación en GitHub requiere una operación administrativa no disponible en esta sesión.
- `CODEOWNERS` asigna responsabilidad al mantenedor actual, pero no impone aprobaciones por sí mismo. Sin una protección efectiva, no debe presentarse como bloqueo de merge.
- Hay ramas históricas y ramas de trabajo en el remoto que requieren clasificación individual. No se elimina ninguna rama sin confirmar su PR asociada, estado de merge y commits exclusivos.

Estas limitaciones son controles de plataforma pendientes, no conformidad de seguridad. No se simula su activación ni se eluden protecciones.
