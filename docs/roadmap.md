# Roadmap de implementación

**Baseline: 1-nov-2026.** El MVP local-first y las tres líneas de consolidación posteriores están integradas en `main`. Las issues reflejan trabajo implementado, exploración y nuevas capacidades; el estado de GitHub es la referencia operativa para saber si una tarea está abierta o cerrada.

## Prioridades

- **P0 — Fundamentos:** integridad de cálculos, persistencia, seguridad y runtime.
- **P1 — Gestión diaria:** cuentas, movimientos, presupuestos, importación e informes.
- **P2 — Capacidad útil y fiabilidad:** IA local opcional, MCP, recuperación, inteligencia, patrimonio y herramientas de apoyo.
- **P3 — Evolución:** optimización, portabilidad y experimentos arquitectónicos condicionados por evidencia.

## Fase 0 — Fundamentos y MVP

- [x] #2–#6: workspace TypeScript, Actual local, adaptador oficial, cálculos deterministas y API local.
- [x] #7–#12: shell web, cuentas/categorías/movimientos, registro con confirmación, dashboard, importación y presupuestos.
- [x] #13–#18: Ollama local opcional, MCP read-only, chat, seguridad/E2E y backup inicial.
- [x] #19–#20: pagos recurrentes candidatos, sugerencias de categorías y previsiones explicables.

## Fase 1 — Consolidación y aceptación operativa (1-nov-2026)

- [x] [#64 — Backup y restauración unificados](https://github.com/miguel-np/personal-budget/issues/64), PR [#89](https://github.com/miguel-np/personal-budget/pull/89): backup cifrado/versionado de Actual y nueve almacenes JSON propios; manifiesto v2 y binarios documentales con inventario, tamaño y SHA-256; compatibilidad con copias v1.
- [x] [#72 — Revisión financiera periódica y guiada](https://github.com/miguel-np/personal-budget/issues/72), PR [#82](https://github.com/miguel-np/personal-budget/pull/82): revisiones semanales/mensuales, decisiones metadata-only, huellas de evidencia, identidad estable y compatibilidad de datos anteriores.
- [x] [#31 — Aceptación operativa Windows + WSL2](https://github.com/miguel-np/personal-budget/issues/31): instalación limpia, doctor, UI abierta desde Windows, inventario sintético antes/después de reinicio de Actual y WSL2, error controlado y parada sin procesos huérfanos. Ensayo registrado el 1-nov-2026.
- [x] [#28 — Paginación y rendimiento de historiales](https://github.com/miguel-np/personal-budget/issues/28), PR [#63](https://github.com/miguel-np/personal-budget/pull/63): ventanas mensuales, máximo de 100.000 movimientos presentados por petición, selección acotada, orden estable, benchmark de heap muestreado y recorrido de páginas sin omisiones/duplicados en conjuntos estáticos.
- [x] [#65 — Contratos financieros neutrales respecto del proveedor](https://github.com/miguel-np/personal-budget/issues/65), PR [#96](https://github.com/miguel-np/personal-budget/pull/96): contratos y errores de dominio en finance-core, API sin dependencia directa del SDK y suite reutilizable de conformidad.

## Fase 2 — Inteligencia financiera útil (integrada el 1-nov-2026)

- [x] [#68 — Centro de inteligencia financiera](https://github.com/miguel-np/personal-budget/issues/68), PR [#78](https://github.com/miguel-np/personal-budget/pull/78): hallazgos deterministas, evidencias, revisión local y explicación cualitativa opcional.
- [x] [#69 — Detección de anomalías](https://github.com/miguel-np/personal-budget/issues/69), PR [#80](https://github.com/miguel-np/personal-budget/pull/80): cambios inusuales y reglas explicables, sin afirmar fraude.
- [x] [#70 — Planificador conversacional de ahorro](https://github.com/miguel-np/personal-budget/issues/70), PR [#81](https://github.com/miguel-np/personal-budget/pull/81): extracción acotada de intención y simulación no persistente.
- [x] [#71 — Clasificación híbrida con IA local](https://github.com/miguel-np/personal-budget/issues/71), PR [#79](https://github.com/miguel-np/personal-budget/pull/79): reglas primero, IA local optativa, abstención ante incertidumbre y confirmación humana.
- [x] [#73 — Saldo estimado y flujo de caja](https://github.com/miguel-np/personal-budget/issues/73), [#83 — Propuestas de mejora presupuestaria](https://github.com/miguel-np/personal-budget/issues/83) y [#74 — Alertas presupuestarias](https://github.com/miguel-np/personal-budget/issues/74), PR [#93](https://github.com/miguel-np/personal-budget/pull/93): proyecciones 7/30/90 días, escenarios, propuestas simulables y reglas locales de aviso.
- [x] [#75 — Exportación PDF y XLSX](https://github.com/miguel-np/personal-budget/issues/75), PR [#77](https://github.com/miguel-np/personal-budget/pull/77): informes y movimientos, con previsualización y exportación local.

## Fase 3 — Gestión patrimonial y portabilidad (integrada el 1-nov-2026)

- [x] [#76 — Exportación portable de datos locales](https://github.com/miguel-np/personal-budget/issues/76).
- [x] [#86 — Activos, inversiones y deudas externas](https://github.com/miguel-np/personal-budget/issues/86).
- [x] [#88 — Justificantes locales vinculados a movimientos](https://github.com/miguel-np/personal-budget/issues/88).
- Las tres se integraron en [PR #94](https://github.com/miguel-np/personal-budget/pull/94): activos/pasivos manuales, snapshots de valoración, custodia privada de documentos, metadatos y vínculos verificados, exportación legible y backup v2.
- [x] [#95 — División del bundle web por rutas](https://github.com/miguel-np/personal-budget/pull/95): lazy loading de paneles y reducción del bundle inicial.
- [x] [#92 — Corrección de aviso de seguridad minimatch](https://github.com/miguel-np/personal-budget/pull/92): dependencia transitiva fijada a versión corregida y auditorías moderadas como error.

## Siguiente etapa

- [ ] [#84 — Búsqueda web controlada desde el asistente local](https://github.com/miguel-np/personal-budget/issues/84): primera entrega integrada por PR [#97](https://github.com/miguel-np/personal-budget/pull/97) y segunda iteración documental integrada por PR [#98](https://github.com/miguel-np/personal-budget/pull/98). La implementación mantiene búsqueda exacta consentida y recuperación de hasta tres documentos por petición. La allowlist de recuperación usa hosts exactos, distinta de los grupos de filtro; el DOG se identifica por su ruta en el portal de la Xunta y Seguridad Social incluye su sede electrónica oficial. El contexto opcional de comunidad, municipio, tipo de contribuyente y fecha del hecho se envía solo a Ollama local, no a SearXNG. Para normas BOE-A se consultan metadatos/relaciones y se evalúan sus marcas frente a referenceDate. El HTML recuperado es la consolidación más reciente; eventDate no selecciona versiones históricas por artículo. La API BOE documenta texto XML versionado por bloque, pero esa selección histórica aún no está integrada. Issue abierta para aceptación live con organismos, PDF, corpus fiscal/legal de discrepancias y selección histórica por bloque/transitorias; no es un motor de dictamen ni garantiza vigencia jurídica.
- [ ] [#85 — Proveedores de IA intercambiables](https://github.com/miguel-np/personal-budget/issues/85): Ollama, OpenAI y xAI detrás de adaptadores independientes. Debe seguir siendo opcional y respetar privacidad/capacidades de cada modelo.
- [ ] [#87 — Espacio fiscal y calendario de obligaciones](https://github.com/miguel-np/personal-budget/issues/87): ejercicios, perfil explícito, tareas y vencimientos basados en fuentes vigentes. No inferir obligaciones a partir de movimientos o ubicación aproximada.

## Exploración arquitectónica condicionada

- [ ] [#66 — ADR sobre la dependencia de Actual Budget](https://github.com/miguel-np/personal-budget/issues/66): comparar permanencia en Actual, ampliar el adaptador y alternativas con métricas, coste de mantenimiento, licencia y ruta de migración. No presupone sustituir Actual.
- [ ] [#67 — Prototipo SQLite de solo lectura](https://github.com/miguel-np/personal-budget/issues/67): solo comenzar si el ADR #66 demuestra una hipótesis medible y define el alcance. Datos exclusivamente sintéticos; nunca es una migración ni un proveedor de producción por defecto.

## Principios que no deben degradarse

- Actual sigue siendo la fuente de verdad financiera.
- Los importes autoritativos y las simulaciones los calcula `finance-core`, no el modelo generativo.
- Datos ausentes/desconocidos no se convierten en cero.
- Los candidatos no confirmados no se mezclan con compromisos reales.
- Las escrituras requieren previsualización/confirmación donde corresponda.
- Backup cifrado, exportación portable y exportación de informes son contratos distintos.
- Toda nueva persistencia propia debe entrar en whitelist, esquema, pruebas de recuperación, inventario y documentación.
- Una prueba sintética o CI verde no se presenta como aceptación manual en otra instalación.
