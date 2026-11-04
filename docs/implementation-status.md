# Estado de implementación

**Baseline: 4-nov-2026 (`main` = `90f627e3`).** Las funcionalidades descritas como integradas están presentes en `main`. Se distingue la integración del código, la validación automatizada y la aceptación manual del entorno. Las PR [#97](https://github.com/miguel-np/personal-budget/pull/97) y [#98](https://github.com/miguel-np/personal-budget/pull/98) incorporan búsqueda controlada y recuperación documental oficial. La PR [#111](https://github.com/miguel-np/personal-budget/pull/111) añadió recuperación histórica BOE por bloque; [#113](https://github.com/miguel-np/personal-budget/pull/113) integró el corpus provisional de 13 casos; y [#114](https://github.com/miguel-np/personal-budget/pull/114) separó la cobertura de hosts de la revisión real de privacidad. Las PR [#116](https://github.com/miguel-np/personal-budget/pull/116), [#117](https://github.com/miguel-np/personal-budget/pull/117), [#118](https://github.com/miguel-np/personal-budget/pull/118) y [#119](https://github.com/miguel-np/personal-budget/pull/119) completaron la primera iteración de cotejo literal de evidencia, clasificación/procedencia, abstención fiscal ante evidencia no resuelta y comparación descriptiva de metadatos/versiones históricas. La PR #119 se fusionó en `main` como [`0dcfe45`](https://github.com/miguel-np/personal-budget/commit/0dcfe45cd61f97659f23951ab4a9983c9a838bdb); sus seis checks de CI/Security pasaron sobre el HEAD validado. La PR [#121](https://github.com/miguel-np/personal-budget/pull/121) añadió cinco herramientas financieras agregadas de solo lectura y cinco prompts MCP, además de Skills de workflow; estas Skills no se cargan automáticamente en el chat Ollama integrado. #106 sigue pendiente de endpoint desplegado y aceptación live con revisión de privacidad; #108 sigue pendiente de aprobación fiscal/jurídica humana de los 13 casos; #110 sigue abierta porque el cotejo literal no demuestra entailment y no detecta por sí mismo todas las discrepancias jurídicas. #109 está cerrada como `not_planned`; PDF/OCR no se soportan.

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
| IA/MCP | Integrados como capacidades opcionales | Ollama local sin herramientas; MCP por stdio con 12 herramientas financieras de consulta/simulación no persistente y cinco prompts reutilizables. Las Skills de workflow orientan clientes compatibles y no se cargan automáticamente en el chat Ollama. |
| Contratos neutrales | Integrados | #65 cerrada; suite de conformidad para proveedor de referencia y adaptador Actual. |
| Búsqueda web #84 | Implementación integrada; trazabilidad, clasificación, cobertura de publicación primaria y comparación conservadora de metadatos | Consentimiento por petición, SearXNG aislado del contexto financiero, recuperación oficial HTML/XHTML/texto, allowlist exacta y hardening SSRF/DNS. La reconstrucción BOE por bloques selecciona versiones históricas por artículo y `eventDate` cuando la cita identifica el artículo; sigue siendo informativa. El corpus provisional de 13 casos está en [legal-tax-corpus.md](legal-tax-corpus.md); todos siguen `reviewStatus: pending` hasta revisión fiscal/jurídica humana competente. Las PR #116–#119 integran comprobación literal de citas contra extractos recuperados, localizadores contrastados cuando existen y posibles discrepancias señaladas con fragmentos enlazados. La coincidencia literal no prueba entailment ni resuelve jerarquía o aplicabilidad. La comparación de fuentes contrasta clases, fechas del proveedor, metadatos temporales BOE y, cuando la cita coincide con un bloque histórico seleccionado por el backend, fechas y norma modificadora de esa versión; jurisdicción, rango, materia y aplicabilidad quedan para revisión humana. #106 sigue pendiente de endpoint live y revisión manual de privacidad; #108, de aprobación humana; #110, de validación semántica/documental y revisión de discrepancias. #109 se cerró fuera de alcance; PDF/OCR no soportados. No es dictamen jurídico. |

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

**Estado en main (4-nov-2026, commit `90f627e3`):** la primera entrega (#97), la recuperación documental oficial (#98) y el endurecimiento posterior (#99, #100, #101, #103 y #104) están integrados. La PR #102 se cerró sin merge y fue sustituida por #103. Las PR #116–#119 integraron cotejo literal de citas, clasificación/procedencia, cobertura de publicación primaria, abstención fiscal conservadora y comparación descriptiva de metadatos. La integración #121 amplió MCP con cinco herramientas financieras agregadas y cinco prompts reutilizables, sin añadir herramientas al chat Ollama. Las revisiones incorporadas incluyen:

- Separación entre grupos de filtro `OFFICIAL_SOURCE_DOMAINS` y hosts exactos `OFFICIAL_SOURCE_HOSTS`; no se hereda confianza por subdominio.
- DOG reconocido solo en la ruta de la edición electrónica del portal oficial de la Xunta; `dog.gal` no se acepta como host oficial independiente.
- Contexto fiscal explícito (comunidad, municipio, tipo de contribuyente, fecha del hecho) enviado solo a Ollama local, nunca a SearXNG ni derivado de datos financieros.
- Política común IPv4/IPv6 basada en registros IANA, con DNS público validado y fijado, bloqueo de destinos especiales/no globales y rechazo de redirecciones.
- Evidencia UI que distingue la consolidación BOE más reciente de una versión histórica seleccionada por bloque y fecha; `eventDate` solo selecciona una redacción cuando se identifica un artículo y el backend puede resolver inequívocamente el bloque/versionado.

El flujo mantiene dos rutas aisladas:
- El chat financiero recibe agregados calculados por backend y no obtiene herramientas.
- La investigación web requiere consentimiento por petición, expone una única herramienta `web_search` y envía a SearXNG exactamente la consulta aprobada. No consulta cuentas, movimientos, saldos ni agregados financieros.
- El backend puede recuperar hasta tres documentos oficiales HTML/XHTML/texto desde hosts exactos HTTPS. Rechaza redirecciones, valida y fija DNS público y aplica límites de tamaño/tiempo. PDF y formatos desconocidos se declaran no compatibles.
- Para identificadores BOE-A consulta metadatos y relaciones de la API oficial, además de la consolidación HTML más reciente. Los indicadores temporales son evidencia limitada, no una determinación completa de vigencia jurídica.

**Validación registrada:** los comentarios de #84 registran CI satisfactoria para las PR #99, #100, #101, #103 y #104 en los controles aplicables de Linux/Windows, calidad, E2E y seguridad. La CI sintética no equivale a aceptación live contra SearXNG u organismos externos.

**Pendiente para cerrar #84:**

1. [#106 — Aceptación E2E real de SearXNG y fuentes oficiales](https://github.com/miguel-np/personal-budget/issues/106): el workflow manual existe y la PR [#114](https://github.com/miguel-np/personal-budget/pull/114) corrige el informe. Falta el secreto `PERSONAL_BUDGET_ACCEPTANCE_API_URL` con el origen HTTPS del backend desplegado, ejecutar `workflow_dispatch`, revisar los resultados host a host e inspeccionar el tráfico API→SearXNG y los logs reales. El informe ahora deja privacidad en `requires_manual_review`; no se aceptará por CI sintética.
2. [#107 — Versiones históricas BOE por bloque y fecha](https://github.com/miguel-np/personal-budget/issues/107): **cerrada como completada** tras integrar #111/#112 y validar el ejemplo oficial BOE del artículo 32 y los límites XML. No resuelve transitorias ni derogaciones tácitas.
3. [#108 — Corpus fiscal/legal](https://github.com/miguel-np/personal-budget/issues/108): corpus provisional de 13 casos integrado por PR [#113](https://github.com/miguel-np/personal-budget/pull/113), con pruebas deterministas, jurisdicción estatal/Galicia/Madrid, snapshots y citas. [La guía del corpus](legal-tax-corpus.md) documenta fuentes y actualización. Se mantiene pendiente la revisión/aprobación de resultados por una persona competente; no es corpus jurídico aprobado.
4. PDF queda fuera del alcance base: [#109](https://github.com/miguel-np/personal-budget/issues/109) se cerró como `not_planned`; se rechazan MIME no admitidos y OCR no está soportado.
5. [#110 — Trazabilidad de afirmaciones y discrepancias](https://github.com/miguel-np/personal-budget/issues/110): la API/UI comprueba fragmentos literales, distingue clases de fuente y detecta cuándo una publicación primaria incluida entre resultados no se cita; la clasificación semántica es propuesta por el modelo y no valida entailment ni resuelve conflictos jurídicos.

La issue #84 permanece abierta hasta completar aceptación live y revisión de privacidad (#106), aprobación humana del corpus (#108) y validación semántica/conflictos (#110).
## Issues abiertas posteriores

- [#85 — Proveedores de IA intercambiables](https://github.com/miguel-np/personal-budget/issues/85): capa de adaptadores para Ollama, OpenAI y xAI; abierta.
- [#87 — Espacio fiscal y calendario](https://github.com/miguel-np/personal-budget/issues/87): obligaciones configuradas explícitamente, por ejercicio y con fuentes; abierta.
- [#66 — ADR sobre Actual](https://github.com/miguel-np/personal-budget/issues/66): evaluación comparativa condicionada por métricas; abierta, P3.
- [#67 — Prototipo SQLite read-only](https://github.com/miguel-np/personal-budget/issues/67): solo si #66 lo justifica; abierta, P3.
