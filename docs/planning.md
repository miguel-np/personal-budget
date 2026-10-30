# Planificación: recurrentes, sugerencias y previsiones

La sección Planificación de la shell añade las mejoras P3: detección de pagos recurrentes, sugerencias de categoría para movimientos sin clasificar y simulaciones presupuestarias explicables. Todo el procesamiento permanece local y las cifras las calcula `finance-core`.

## Pagos recurrentes

`GET /api/v1/insights/recurring` detecta candidatos con señales deterministas: beneficiario normalizado, número de cargos (mínimo 3 por defecto), huecos entre fechas (cadencia semanal/quincenal/mensual/trimestral/anual) y similitud de importe (desviación máxima, 20 % por defecto). La ventana de cadencia por defecto es de 20–45 días.

La salida de cada candidato incluye:

- `signals`: explicación de la cadencia inferida y la estabilidad del importe.
- `warnings`: riesgos de falso positivo conocidos — abonos/reembolsos excluidos, fechas desplazadas, importes variables y agrupación por texto normalizado de nombres similares.
- `confidence: candidate_only`: un candidato no garantiza que el gasto se repita.

## Sugerencias de categoría

`GET /api/v1/insights/category-suggestions` propone una categoría para movimientos de gasto sin clasificar usando el historial local de los últimos 12 meses: el beneficiario normalizado vota con sus movimientos categorizados previos; gana la categoría con más evidencia (la más reciente en caso de empate). No se sugieren categorías de ingreso y no se aprenden ni almacenan reglas nuevas.

## Confirmación con previsualización

`POST /api/v1/insights/categorize` acepta cambios por movimiento o en lote. Sin `commit` solo previsualiza; con `commit: true` escribe la categoría en Actual Budget a través del adaptador oficial. La API valida que la transacción pertenezca a una cuenta abierta del periodo y que la categoría sea de gasto. La interfaz permite editar la categoría, aplicar o descartar cada sugerencia y aplicar todas las visibles con confirmación explícita.

## Previsiones explicables

`POST /api/v1/forecasts/simulate` calcula escenarios hipotéticos sobre el historial local:

- `category_reduction`: reducción porcentual de una categoría de gasto (usa la mediana mensual de esa categoría).
- `income_change`: cambio porcentual del ingreso mensual (usa la mediana mensual del historial).

La previsión separa el gasto recurrente estimado (transacciones de candidatos recurrentes) del extraordinario/variable, proyecta cada mes del horizonte (1–60 meses) y devuelve `assumptions` (supuestos explícitos) y `warnings` (historial insuficiente, ingresos cero o irregulares, picos extraordinarios, horizonte sin datos). Mismos datos y parámetros producen el mismo resultado; la UI marca todo como **estimación, no garantía** y nunca crea ni edita movimientos reales.

## Validación registrada (25-oct-2026)

- Candidato real detectado contra el presupuesto sintético: `supermercado`, 3 cargos, cadencia mensual de 30 días, importe medio estable.
- Sugerencia real aplicada: un movimiento sin categoría de `Supermercado` recibió `Comida` (2 evidencias); la previsualización no escribió y el commit dejó la categoría actualizada en Actual Budget.
- Previsión verificada: determinismo bit a bit entre llamadas idénticas, reducción del 10 % en `Comida` calculada sobre la mediana de la categoría (450 → 4500−450), avisos por historial de 2 meses y por horizonte sin datos.
- Pruebas de `finance-core`: importes variables, fechas desplazadas, reembolsos, nombres similares, cadencia semanal/anual, empates de categoría, ingresos cero, picos extraordinarios e historial insuficiente.

## Objetivos de ahorro y compromisos futuros

La nueva sección **Objetivos** añade objetivos de ahorro, aportaciones deseadas, supuestos de ingreso/gasto y compromisos manuales puntuales o recurrentes. La API persiste estos datos en un fichero local independiente de Actual Budget, y finance-core calcula el progreso y el flujo mensual estimado. La agenda combina la lista y el calendario con el mismo conjunto de elementos y etiqueta claramente los compromisos manuales, las operaciones futuras ya registradas y los candidatos recurrentes no confirmados.

Las proyecciones incluyen doce meses naturales (los meses vacíos cuentan como cero), excluyen traspasos, aplican únicamente compromisos activos de la misma divisa y ámbito de cuentas y limitan cada aportación al efectivo mensual estimado disponible. No se aplican intereses ni se escriben movimientos en Actual. Si cambia la divisa o el ámbito guardado, el registro requiere revisión explícita antes de ser proyectado.

La copia cifrada existente de Actual **no incluye** planning-data.json: el fichero está bajo ACTUAL_DATA_DIR, distinto del directorio de datos del servidor empaquetado por el backup de Actual. Consulta [Objetivos de ahorro y compromisos futuros](planning-goals.md) para el contrato API, supuestos financieros, límites y procedimiento de copia local.


## Planificador conversacional de ahorro (#70)

La sección Planificación incluye un planificador conversacional opcional. El usuario puede describir una meta, comparar aportaciones mensuales o comprobar el efecto de un gasto extraordinario sobre un objetivo existente. El flujo es una capa de entrada para las simulaciones deterministas; no sustituye a Objetivos ni a los formularios existentes.

### Flujo y contrato

- La UI envía únicamente el texto de la petición a `POST /api/v1/planning/conversation/preview`.
- La extracción local devuelve un objeto JSON estructurado: tipo de intención, objetivo existente opcional, importe y fecha objetivo, ahorro inicial, aportación, alternativas comparables, supuestos de ingresos/gastos y gasto extraordinario opcional.
- El modelo recibe la fecha actual, la divisa de análisis y como máximo 50 pares de identificador/nombre de objetivos activos compatibles. No recibe movimientos, descripciones bancarias, IDs de transacciones/cuentas, saldos, importes históricos, categorías, notas ni historial.
- Zod valida la respuesta estrictamente en el backend. Se rechazan propiedades adicionales, fechas no válidas, importes fuera de rango, divisas no compatibles, opciones insuficientes y referencias a objetivos no disponibles.
- Los campos ausentes o una pregunta ambigua producen `clarification_required`; no se completan con fechas, importes o divisas inventados.
- Los importes del modelo se tratan únicamente como entradas propuestas en unidades principales de la divisa. El backend aplica la precisión monetaria de `Intl.NumberFormat`, convierte a unidades menores y comprueba enteros seguros.
- El backend obtiene el historial de doce meses del ámbito actual, aplica conversiones locales ya configuradas y calcula con `estimatePlanningCashFlow` y `projectSavingsGoal`. El LLM no calcula cifras, porcentajes, viabilidad o fechas finales.
- Las simulaciones de aportaciones comparan varias llamadas deterministas a finance-core. Una prueba de gasto crea un compromiso efímero en memoria para el escenario, sin guardarlo.
- La respuesta identifica divisa, ámbito de cuentas, periodo histórico, meses con datos, número de movimientos, fuentes de ingresos/gastos, compromisos considerados, supuestos y advertencias.
- El endpoint no ofrece una operación de guardado. La creación o edición de un objetivo sigue siendo una acción independiente desde Objetivos, con su propio formulario y confirmación explícita.

### Seguridad, privacidad y degradación

El planificador requiere `AI_ENABLED=true`, un modelo instalado y Ollama en loopback. Si AI está desactivada o el runtime falla, el endpoint devuelve un error saneado y los formularios deterministas siguen disponibles. La extracción usa JSON Schema, temperatura cero, timeout, cola y límites de concurrencia ya compartidos por `LocalAiClient`. Prompts y respuestas no se registran; las métricas solo contienen resultado, duración y tamaño aproximado del contexto.

No se mezclan divisas. Si la petición especifica otra distinta de la divisa de análisis, se pide reformularla en la divisa actual; no se aplica una conversión futura implícita. Los objetivos pausados o cuyo ámbito/divisa haya cambiado no se simulan.

### Evaluación y pruebas

La suite sintética de CI cubre objetivo nuevo, comparación de varias aportaciones, gasto extraordinario, pregunta incompleta, IA desactivada, ausencia de escrituras en Actual y ausencia de cambios en objetivos/compromisos persistidos. Las pruebas de LocalAiClient verifican el contrato JSON Schema, la ausencia de datos de movimientos en el prompt y el rechazo de JSON mal formado.

Hay una aceptación opcional con Ollama real y prompts sintéticos versionados. Ejecuta `PERSONAL_BUDGET_RUN_PLANNING_AI_ACCEPTANCE=1 OLLAMA_MODEL=<modelo-local> npm run test:planning-ai:acceptance`. La evaluación informa exactitud de campos estructurados y recall de aclaraciones; no forma parte de CI porque requiere el modelo local y el hardware del usuario. Sus resultados deben registrarse por modelo, versión y entorno, y no representan cobertura lingüística universal.
