# Estado de implementación

**Baseline: 1-nov-2026.** Las funcionalidades descritas como integradas están presentes en `main`. Se distingue la integración del código, la validación automatizada y la aceptación manual del entorno. La primera entrega de búsqueda web de #84 está integrada mediante PR [#97](https://github.com/miguel-np/personal-budget/pull/97), con CI Linux/Windows, E2E y aceptación Actual en verde. La segunda iteración documental está en revisión en [PR #98](https://github.com/miguel-np/personal-budget/pull/98) y todavía no forma parte de `main`; la issue sigue abierta.

## Estado general

| Área | Estado | Evidencia / límite |
|---|---|---|
| Núcleo financiero | Integrado | Actual como fuente de verdad; adapter y finance-core separados. |
| Gestión diaria | Integrada | Dashboard, cuentas, movimientos, splits, transferencias, presupuestos, informes y edición. |
| Importación | Integrada | CSV y OFX local con revisión; OFX SGML 1.02/1.03 y XML 2.x en los perfiles documentados. |
| Multidivisa | Integrada | Divisas nativas, excepciones explícitas y tipos de cambio manuales fechados; no hay cotizaciones automáticas. |
| Planificación | Integrada | Recurrentes candidatos, sugerencias híbridas, previsiones, metas, compromisos y planificador conversacional. |
| Inteligencia | Integrada | Hallazgos, anomalías, revisiones, flujo de caja, propuestas y alertas locales. |
| Exportación | Integrada | CSV, JSON, PDF imprimible y XLSX; exportación portable separada. |
| Patrimonio y documentos | Integrado | Activos/pasivos externos, valoraciones manuales, justificantes privados y vínculos verificados. |
| Backup/restore | Integrado | Actual + estado propio, manifiesto v2, nueve JSON y binarios documentales inventariados. |
| IA/MCP | Integrados como capacidades opcionales | Ollama local y MCP de solo lectura; modelos/modelos runtime concretos requieren validación. |
| Contratos neutrales | Integrados | #65 cerrada; suite de conformidad para proveedor de referencia y adaptador Actual. |
| Búsqueda web #84 | Primera entrega integrada (PR [#97](https://github.com/miguel-np/personal-budget/pull/97)); segunda iteración en PR [#98](https://github.com/miguel-np/personal-budget/pull/98), aún no integrada; issue abierta | La PR #98 añade recuperación acotada de HTML/texto oficial, API BOE de metadatos/relaciones, evaluación temporal fechada, clasificación DGT/TEAC y límites explícitos. Pendientes CI, aceptación real, PDF y corpus de contradicciones jurídicas; no equivale a un motor de vigencia legal. |

## Consolidación — fase 1

| Issue | Estado verificable | Alcance integrado y límites |
|---|---|---|
| [#64 — Backup unificado](https://github.com/miguel-np/personal-budget/issues/64) | Cerrada, PR [#89](https://github.com/miguel-np/personal-budget/pull/89) | Backup cifrado/versionado de volumen Actual y estado propio. La extensión de fase 3 usa manifiesto v2 y documentos binarios. |
| [#72 — Revisión periódica](https://github.com/miguel-np/personal-budget/issues/72) | Cerrada, PR [#82](https://github.com/miguel-np/personal-budget/pull/82) | Revisión semanal/mensual, comparables, evidencia, identidades estables y decisiones locales metadata-only. |
| [#31 — Aceptación operativa](https://github.com/miguel-np/personal-budget/issues/31) | Cerrada el 1-nov-2026 | Ensayo manual completo en Ubuntu 24.04.5/WSL2 objetivo, navegador Windows, reinicio del contenedor y WSL2, inventario sintético idéntico, diagnóstico de fallo y parada limpia. Repetir al instalar en otra máquina. |
| [#28 — Paginación y rendimiento](https://github.com/miguel-np/personal-budget/issues/28) | Cerrada el 1-nov-2026, PR [#63](https://github.com/miguel-np/personal-budget/pull/63) | Ventanas mensuales, límite de 100.000 movimientos presentados, heap acotado, orden estable, benchmark y recorrido estático completo. No existe cursor ni snapshot entre peticiones; cambios concurrentes pueden desplazar páginas. |
| [#65 — Contratos neutrales](https://github.com/miguel-np/personal-budget/issues/65) | Cerrada, PR [#96](https://github.com/miguel-np/personal-budget/pull/96) | Contratos neutrales y errores de dominio en finance-core, eliminación de casts API→Actual, composición del SDK dentro del adaptador y suite de conformidad reutilizable. Las migraciones entre proveedores siguen siendo específicas. |

### Recuperación y persistencia actual

El backup unificado se cifra con AES-256-GCM y mantiene la clave separada. El manifiesto v2 inventaría:

1. Volumen persistente completo del servidor Actual.
2. Nueve almacenes JSON propios: `app-preferences.json`, `account-scope-preferences.json`, `currency-preferences.json`, `financial-intelligence-state.json`, `financial-actions.json`, `planning-data.json`, `periodic-reviews.json`, `wealth-data.json` y `documents-index.json`.
3. Binarios PDF/JPEG/PNG en el área documental privada, cada uno validado por nombre generado, tamaño, firma y SHA-256.

El restore valida autenticidad, manifiesto, inventario y rutas antes de sustituir datos, y conserva el estado anterior para rollback. Las copias v1 siguen siendo válidas, pero no contienen los conjuntos patrimoniales/documentales nuevos; su restauración conserva esos conjuntos actuales en vez de borrarlos silenciosamente.

La CI valida roundtrip en una instancia Actual aislada con datos sintéticos. Antes de depender de una copia personal, conserva la clave por separado y ejecuta una restauración de ensayo en una instancia aislada.

## Inteligencia financiera — fase 2

Las issues #73, #83 y #74 se integraron mediante el commit `9164741` y PR [#93](https://github.com/miguel-np/personal-budget/pull/93).

| Issue | Estado integrado | Límites |
|---|---|---|
| [#73 — Flujo de caja](https://github.com/miguel-np/personal-budget/issues/73) | Proyección diaria de 7/30/90 días, movimientos futuros, compromisos, recurrencias confirmadas, hipótesis seleccionadas y reserva. | El saldo de apertura usa `balance_current` de Actual; no equivale necesariamente a saldo bancario disponible o liquidado. Saldo desconocido o sin conversión válida permanece `null`. |
| [#83 — Propuestas presupuestarias](https://github.com/miguel-np/personal-budget/issues/83) | Línea base de periodos completos, categorías clasificadas por el usuario, propuestas y escenarios combinados reproducibles. | Solo categorías marcadas flexibles/revisables; cifras hipotéticas no son ahorro garantizado. No cambia asignaciones automáticamente ni exige IA. |
| [#74 — Alertas locales](https://github.com/miguel-np/personal-budget/issues/74) | Umbrales de consumo/restante/exceso por categoría, deduplicación, silencio y aplazamiento. | Solo in-app, se recalculan al consultar; no hay push, email ni proceso residente. |

El almacén `financial-actions.json` está en el backup unificado.

## Centro de inteligencia y planificación

- [#68 — Centro de inteligencia](https://github.com/miguel-np/personal-budget/issues/68), PR [#78](https://github.com/miguel-np/personal-budget/pull/78): hallazgos con reglas, métricas y evidencia; explicación cualitativa local opcional.
- [#69 — Anomalías](https://github.com/miguel-np/personal-budget/issues/69), PR [#80](https://github.com/miguel-np/personal-budget/pull/80): detector determinista; señala variaciones inusuales, no fraude.
- [#70 — Planificador conversacional](https://github.com/miguel-np/personal-budget/issues/70), PR [#81](https://github.com/miguel-np/personal-budget/pull/81): extrae parámetros y simula; no escribe metas/compromisos.
- [#71 — Clasificación híbrida](https://github.com/miguel-np/personal-budget/issues/71), PR [#79](https://github.com/miguel-np/personal-budget/pull/79): reglas primero, IA local opt-in, abstención ante ambigüedad y confirmación explícita.
- [#75 — PDF/XLSX](https://github.com/miguel-np/personal-budget/issues/75), PR [#77](https://github.com/miguel-np/personal-budget/pull/77): exportación local con comprobación de integridad de páginas y anexos.

## Patrimonio y portabilidad — fase 3

Las issues [#76](https://github.com/miguel-np/personal-budget/issues/76), [#86](https://github.com/miguel-np/personal-budget/issues/86) y [#88](https://github.com/miguel-np/personal-budget/issues/88) se integraron mediante [PR #94](https://github.com/miguel-np/personal-budget/pull/94).

- Registro manual de activos/pasivos externos y snapshots históricos con fecha, divisa y procedencia.
- Clasificación explícita de cuentas de Actual como activo o pasivo.
- Patrimonio neto con cobertura incompleta explícita ante valoraciones caducadas/desconocidas o falta de conversión.
- Archivo documental privado de PDF/JPEG/PNG y metadata versionada.
- Vínculos a movimientos comprobados contra ID, cuenta y fecha leídos de Actual.
- Exportación portable seleccionable de datos locales y presupuestos accesibles; exportación humana no importable ni restaurable.
- Binarios documentales incluidos en backup v2 solo mediante inventario explícito.

No se infieren rentabilidad, deducibilidad ni valoraciones de mercado; las valoraciones son manuales.

## Operación, seguridad y rendimiento

- **#31:** aceptación manual WSL2 completada. CI Linux/Windows no sustituye el ensayo de una instalación distinta.
- **#28:** límite de 100.000 movimientos presentados por petición, ventanas de mes natural y selección acotada. Actual no ofrece cursor; offset no proporciona snapshot entre páginas.
- **#92:** dependencia transitiva minimatch fijada a versión corregida; auditoría moderada falla la CI.
- **#95:** lazy loading de paneles; el chunk inicial pasó de 551 kB a 282 kB (gzip: 149 kB a 85 kB).
- CI cubre Linux, Windows, E2E de navegador, contenedor Actual, aceptación sintética de update/restore, lint, typecheck/build, cobertura, auditorías y escaneo de secretos.

## Búsqueda web controlada — issue #84

**Estado en main:** primera entrega integrada mediante PR [#97](https://github.com/miguel-np/personal-budget/pull/97), con CI Linux/Windows, E2E, Actual update/restore y Security en verde. **Segunda iteración:** PR [#98](https://github.com/miguel-np/personal-budget/pull/98) propone recuperación documental acotada, metadatos temporales BOE y clasificación DGT/TEAC; no está integrada en `main` hasta superar revisión y CI. Issue #84 permanece abierta.

La arquitectura propuesta mantiene dos flujos separados:
- El chat financiero recibe solo agregados backend y sigue sin herramientas.
- La investigación web no consulta el repositorio financiero. Requiere consentimiento por petición, envía únicamente la consulta exacta aprobada a SearXNG y expone al modelo local una única herramienta `web_search`. Tras la búsqueda, los fragmentos se envían como contenido externo no confiable en una segunda inferencia sin herramientas.

El proveedor SearXNG puede ejecutarse en loopback o en un endpoint HTTPS configurado. La lista fiscal se restringe a dominios oficiales admitidos. Las fechas que el buscador devuelve no prueban por sí solas vigencia normativa: la UI conserva el enlace para revisar la fuente original y la respuesta debe reconocer falta de evidencia. Consulta [docs/web-search.md](web-search.md).

## Issues abiertas posteriores

- [#85 — Proveedores de IA intercambiables](https://github.com/miguel-np/personal-budget/issues/85): capa de adaptadores para Ollama, OpenAI y xAI; abierta.
- [#87 — Espacio fiscal y calendario](https://github.com/miguel-np/personal-budget/issues/87): obligaciones configuradas explícitamente, por ejercicio y con fuentes; abierta.
- [#66 — ADR sobre Actual](https://github.com/miguel-np/personal-budget/issues/66): evaluación comparativa condicionada por métricas; abierta, P3.
- [#67 — Prototipo SQLite read-only](https://github.com/miguel-np/personal-budget/issues/67): solo si #66 lo justifica; abierta, P3.
