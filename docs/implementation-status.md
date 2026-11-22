# Estado de implementación

**Snapshot documental:** 22-nov-2026.  
**Rama de referencia:** `main`.  
**Commit consultado:** `8982f285b059b7bef635c6be660f56bd25e2c38b`.

Este documento resume las capacidades integradas y la evidencia disponible en el snapshot indicado. No sustituye el estado de issues, PR o checks actuales de GitHub. Para decidir si una propuesta está validada, consulta el último SHA de la PR y sus ejecuciones.

## Estado técnico de las capacidades

| Área | Estado observado | Alcance y límite |
|---|---|---|
| Núcleo financiero | Integrado | Actual Budget es la fuente de verdad; `finance-core` contiene contratos neutrales y cálculos deterministas. |
| Gestión diaria | Integrada | Resumen, cuentas, movimientos, transferencias, divisiones, presupuestos e informes. |
| Importación | Integrada | CSV y perfiles OFX admitidos, con previsualización y confirmación. |
| Multidivisa | Integrada | Divisas y tasas manuales/locales fechadas; no hay cotizaciones automáticas. |
| Planificación | Integrada | Candidatos recurrentes, sugerencias híbridas, previsiones, objetivos, compromisos y simulación conversacional. |
| Inteligencia financiera | Integrada | Hallazgos, anomalías, revisiones, flujo de caja, propuestas y alertas locales. |
| Patrimonio y documentos | Integrada | Activos/pasivos externos, valoraciones manuales, documentos privados y vínculos comprobados. |
| Backup y portabilidad | Integrada | Backup cifrado de Actual, nueve almacenes JSON propios inventariados y documentos binarios incluidos en el manifiesto. |
| IA y MCP | Integradas como capacidades opcionales | Ollama local; chat integrado sin herramientas. MCP stdio ofrece herramientas financieras de lectura/simulación no persistente. |
| Investigación web | Código integrado; aceptación externa pendiente | Búsqueda consentida, SearXNG separado del contexto financiero, recuperación oficial acotada y controles SSRF/DNS. No constituye dictamen jurídico. |

Para conocer el comportamiento desde la perspectiva de usuario, consulta [Catálogo de funcionalidades](features.md). Los detalles técnicos están en [Arquitectura](architecture.md), [Privacidad](privacy.md), [Backup](backup-restore.md) y las guías específicas.

## Evidencia automatizada observada en el snapshot

En el commit `8982f285b059b7bef635c6be660f56bd25e2c38b`, las ejecuciones publicadas para CI y Security finalizaron correctamente:

| Workflow | Ejecución | Resultado | SHA |
|---|---:|---|---|
| CI | [#742](https://github.com/miguel-np/personal-budget/actions/runs/45058990744) | Success | `8982f285` |
| Security | [#675](https://github.com/miguel-np/personal-budget/actions/runs/45058990753) | Success | `8982f285` |

Esto acredita el resultado de esos workflows en ese commit. No acredita aceptación manual de servicios externos ni garantiza que un entorno personal esté correctamente configurado.

## Aceptación externa o revisión especializada pendiente

| Capacidad | Estado técnico | Condición pendiente |
|---|---|---|
| Investigación web controlada (#84) | Código integrado | Mantener la distinción entre integración y aceptación operativa completa. |
| Aceptación live de búsqueda (#106) | Procedimiento local opt-in documentado | Ejecutar en el equipo local con API loopback y SearXNG configurado; revisar tráfico y logs reales. |
| Corpus fiscal/legal (#108) | Casos sintéticos y regresiones integrados | Revisión y aprobación humana competente de los resultados esperados. |
| Evidencia y discrepancias (#110) | Cotejo y clasificación técnica integrados | Revisión semántica independiente y de soporte por afirmación. |

Una cita literal acredita que el fragmento está presente, no que respalde semánticamente una conclusión. La recuperación de una fuente oficial tampoco certifica por sí sola su vigencia o aplicabilidad jurídica. CI verde no equivale a aprobación fiscal o legal.

## Aceptación del entorno Windows + WSL2

La issue #31 se cerró después de registrar una aceptación manual en Ubuntu sobre WSL2 el 1-nov-2026. El registro incluyó instalación limpia, presupuesto sintético aislado, acceso desde navegador Windows, diagnóstico de fallos, parada/reinicio y comprobación de persistencia tras reiniciar WSL2.

Esa aceptación demuestra el entorno y versiones registrados entonces. No certifica automáticamente todas las versiones futuras ni sustituye las comprobaciones de una instalación nueva. Consulta la guía de [instalación](installation.md) para repetir el procedimiento.

## Gobernanza y limitaciones

- El estado abierto/cerrado de issues y PR se consulta en GitHub.
- El roadmap expresa dirección estratégica, no el estado operativo del backlog.
- Las pruebas sintéticas no sustituyen pruebas live o revisiones humanas cuando se requieren.
- No se declara seguridad absoluta ni ausencia permanente de vulnerabilidades.
- La baseline de dependencias y versiones está en [version-baseline.md](version-baseline.md).
