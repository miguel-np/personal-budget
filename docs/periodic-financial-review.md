# Revisión financiera periódica y guiada

La revisión periódica (#72) reúne en un recorrido explícito el resumen de un periodo, la comparación temporal y los hallazgos que merece la pena comprobar. Está disponible en **Revisión financiera** y se genera bajo demanda; no crea tareas en segundo plano ni envía notificaciones.

## Periodos y fecha de corte

- **Semanal:** semana natural de lunes a domingo para la fecha de referencia.
- **Mensual:** mes natural de la fecha de referencia.
- Si el periodo incluye hoy, el corte termina en la fecha actual y el informe queda identificado como incompleto. El cierre futuro no se anticipa ni se rellenan días sin datos.
- **Semanal:** compara los mismos días de lunes-domingo de la semana anterior. **Mensual:** compara el mes natural anterior; si el mes actual todavía está incompleto, compara el mismo tramo de días del mes anterior, limitado al último día disponible de ese mes. En ambos casos se muestra el rango exacto y no se extrapolan días.
- Las fechas se interpretan como fechas civiles ISO (YYYY-MM-DD) en la zona IANA del navegador (por ejemplo, Europe/Madrid), que se valida y se devuelve en el informe para que el corte, el look-ahead de compromisos y la fecha de referencia coincidan cerca de medianoche. Las llamadas sin zona explícita usan UTC; la API rechaza zonas inválidas y fechas futuras.

## Cálculos y procedencia

La API reutiliza generateIntelligenceData, finance-core.calculateSummary y la misma preferencia global activa de ámbito de cuentas y divisa que el dashboard y los informes. El usuario ve en el informe el periodo exacto, fecha de corte, divisa y etiqueta del ámbito que se aplicaron.

El resumen incluye ingresos, gastos, ahorro neto, tasa de ahorro cuando hay ingresos positivos, movimientos sin conversión y advertencias de calidad. La comparación anterior vuelve a calcularse desde las transacciones del ámbito y las tasas configuradas; no suma monedas incompatibles ni convierte importes desconocidos a cero.

El listado de acciones procede de hallazgos versionados del centro de inteligencia (#68) y de las reglas de anomalías (#69): variaciones entre periodos, anomalías, movimientos sin clasificar, desviaciones presupuestarias cuando se cumplen sus requisitos, objetivos, compromisos manuales y posibles recurrencias. Cada punto conserva su evidencia, regla, confianza, prioridad explicada, impacto conocido o desconocido y destino de navegación.

Las desviaciones de presupuesto solo se presentan cuando los datos de Actual permiten una comparación válida: mes natural completo y cerrado, todas las cuentas y coincidencia de divisa con el presupuesto. Si faltan tasas, hay movimientos sin conversión, el periodo está incompleto o un proveedor no devuelve datos verificables, la API añade advertencias y no inventa cifras.

La confianza (observed, estimated, candidate, suggestion) distingue hechos observados de proyecciones y candidatos. La prioridad (low, medium, high) ordena la revisión; no expresa probabilidad ni certeza. El impacto queda como desconocido si no se puede calcular.

## Decisiones y persistencia

Cada revisión tiene un ID, frecuencia, fechas, fecha de generación, divisa, ámbito y referencias a los hallazgos. Un punto puede marcarse como **revisado** o **aplazado** (siete días desde la interfaz). La revisión se completa cuando no quedan elementos pendientes. Se puede volver a generar el mismo periodo.

Las decisiones de una revisión anterior se reaplican al regenerar solo cuando coinciden el periodo, divisa, ámbito, identificador del hallazgo y huella de evidencia. Si cambia materialmente la evidencia, el punto vuelve a quedar pendiente. Los aplazamientos vencidos también vuelven a quedar pendientes. Así no se arrastra una decisión antigua sobre un hallazgo que ya cambió.

El almacén periodic-reviews.json reside en ACTUAL_DATA_DIR y usa esquema versionado (version: 1), validación estricta, límite de tamaño, escritura atómica, permisos locales restrictivos y serialización de escrituras concurrentes. Guarda únicamente fechas, IDs/tipos/huellas de hallazgos, estado, divisa, etiqueta de ámbito y una huella SHA-256 truncada del conjunto de cuentas. No conserva los IDs ni nombres de las cuentas en el historial. No guarda movimientos, importes transaccionales, descripciones, evidencia completa ni conversaciones. No es una fuente financiera ni permite modificar Actual Budget.

## IA, privacidad y límites

La revisión funciona sin Ollama y esta primera versión es determinista de extremo a extremo. La IA local no calcula métricas, genera prioridades ni decide acciones. No se envían datos financieros a servicios externos, no se usa telemetría y el flujo no realiza pagos, cambios de presupuesto, clasificación automática, asesoramiento de inversión/fiscal/crédito ni notificaciones push/OS.

La IA local de explicación del centro de inteligencia sigue siendo opcional y separada; el informe de revisión no depende de ella. Una caída o desactivación de Ollama no debe impedir generar, consultar ni completar una revisión.

## API local

- GET /api/v1/reviews/periodic: historial local versionado.
- POST /api/v1/reviews/periodic con { "periodType": "weekly" | "monthly", "anchorDate": "YYYY-MM-DD" }: genera el informe, su periodo, corte, resumen, comparación, hallazgos y limitaciones.
- PATCH /api/v1/reviews/periodic/:reviewId/items con { "findingId": "...", "status": "reviewed" | "postponed", "postponedUntil": "YYYY-MM-DD" }: actualiza un punto. Los aplazamientos deben vencer entre hoy y los próximos 90 días.

Las rutas validan el esquema de entrada, no devuelven contenido sensible de errores internos y operan sobre el repositorio de lectura y los almacenes propios de Personal Budget. Generar o actualizar una revisión no invoca mutaciones del adaptador de Actual.

## Backup y restauración

periodic-reviews.json se escribe junto al resto del estado propio en ACTUAL_DATA_DIR. La issue #64 sigue siendo la encargada de unificar la recuperación cifrada de Actual y Personal Budget. **El backup backup:actual existente respalda actualmente el volumen de Actual, no todo ACTUAL_DATA_DIR; por tanto, hasta integrar y validar #64, el historial de revisiones no debe considerarse cubierto por el backup actual.** No se anuncia una recuperación completa ni se sube este archivo a Git.

## Validación

Las pruebas deben cubrir persistencia versionada, escrituras concurrentes, esquema corrupto, periodos incompletos, periodo vacío/ingresos cero, varias cuentas, divisas sin tasa, evidencia repetida o modificada, modelo local no disponible y el recorrido E2E de generar, revisar, aplazar, navegar y regenerar. La validación completa se ejecuta con:

\`\`\`sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
\`\`\`
