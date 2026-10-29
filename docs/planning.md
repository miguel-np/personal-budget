# Planificación: recurrentes, sugerencias y previsiones

La sección Planificación de la shell añade las mejoras P3: detección de pagos recurrentes, sugerencias de categoría para movimientos sin clasificar y simulaciones presupuestarias explicables. Todo el procesamiento permanece local y las cifras las calcula `finance-core`.

## Pagos recurrentes

`GET /api/v1/insights/recurring` detecta candidatos con señales deterministas: beneficiario normalizado, número de cargos (mínimo 3 por defecto), huecos entre fechas (cadencia semanal/quincenal/mensual/trimestral/anual) y similitud de importe (desviación máxima, 20 % por defecto). La ventana de cadencia por defecto es de 20–45 días.

La salida de cada candidato incluye:

- `signals`: explicación de la cadencia inferida y la estabilidad del importe.
- `warnings`: riesgos de falso positivo conocidos — abonos/reembolsos excluidos, fechas desplazadas, importes variables y agrupación por texto normalizado de nombres similares.
- `confidence: candidate_only`: un candidato no garantiza que el gasto se repita.

## Sugerencias híbridas de categoría (reglas + IA local opcional)

`GET /api/v1/insights/category-suggestions` aplica siempre primero las reglas deterministas sobre el historial local de los últimos 12 meses. El beneficiario normalizado vota con sus movimientos previamente categorizados; se conserva el número de evidencias y la fecha más reciente. No se sugieren categorías de ingreso, y las reglas nunca aprenden ni se almacenan de forma implícita. Si las dos categorías más fuertes tienen exactamente el mismo número de votos y fecha de evidencia, la capa determinista se abstiene en lugar de decidir por orden alfabético.

La clasificación híbrida está **desactivada por defecto** y requiere activar ambas opciones explícitamente:

- `AI_ENABLED=true`
- `AI_CATEGORY_CLASSIFICATION_ENABLED=true`
- `OLLAMA_MODEL` con el nombre de un modelo ya instalado en el Ollama local.

`OLLAMA_BASE_URL` solo admite loopback. `AI_CATEGORY_CLASSIFICATION_INCLUDE_PAYEE=true` (por defecto) permite enviar al modelo local las etiquetas normalizadas de los beneficiarios pendientes; al establecerlo en `false`, no se invoca la IA de clasificación y la interfaz solicita una categoría manual. La configuración no habilita APIs remotas ni servicios externos.

### Orden de decisión, contexto y contrato

1. Las coincidencias de reglas con al menos dos movimientos históricos se mantienen como sugerencias deterministas y no se envían al modelo.
2. Solo se consideran como fallback las salidas de gasto sin categoría, sin traspaso y con beneficiario disponible que no tienen evidencia determinista suficiente. Los abonos/reembolsos reconocidos quedan excluidos.
3. Se procesa como máximo una tanda de 12 movimientos por petición; catálogos con más de 100 categorías no se envían al modelo. Los candidatos diferidos se indican en la respuesta y no se presentan como clasificados por IA.
4. El contexto de Ollama contiene únicamente referencias efímeras (`c1`…`c12`), IDs/nombres de categorías de gasto habilitadas y, si la opción lo permite, la etiqueta normalizada del beneficiario. No incluye IDs reales de movimiento, cuentas, importes, fechas, notas, filas históricas ni el lote financiero original. Las referencias efímeras no se registran como datos de usuario.
5. Se exige JSON estructurado con una referencia por candidato, `categoryId` del catálogo permitido o `null`, justificación breve y `uncertainty` cualitativa (`low`, `medium` o `high`). La API rechaza la respuesta entera si tiene referencias ausentes/duplicadas, forma inválida o una categoría no existente/no habilitada. Solo `low` con una categoría permitida puede producir una sugerencia de IA; el resto se representa como **sin sugerencia** y exige decisión humana. No se trata la etiqueta del modelo como probabilidad calibrada.
6. Un error de Ollama, el timeout, la cola saturada, el contexto excesivo o una respuesta inválida degradan a revisión manual; las sugerencias deterministas existentes siguen disponibles. Una petición de sugerencias no realiza escrituras.

El contrato distingue `source: rule_based | local_ai | none`, `confidence` de fuente, incertidumbre cualitativa y justificación. La UI de Planificación muestra la procedencia, permite editar/descartar y solo permite iniciar la previsualización cuando hay una categoría elegida. El guardado continúa usando la ruta de previsualización, baseline de concurrencia optimista, confirmación explícita, verificación de persistencia y resultado parcial inequívoco del flujo existente.

### Evaluación sintética y métricas

La prueba optativa `services/api/tests/local-ai-live-acceptance.test.ts` incluye etiquetas de comercio inventadas y resultados esperados (sin datos financieros personales) y obtiene la línea base ejecutando el `suggestCategories` real de `finance-core`. Contrasta las métricas de la base con el híbrido: **cobertura** = ejemplos con categoría asignada / total; **precisión** = asignaciones correctas / asignaciones realizadas; **tasa de falsos positivos** = casos etiquetados como ambiguos o sin categoría que reciben una asignación / casos ambiguos; **tasa de abstención** = ejemplos sin categoría aceptada / total. La evaluación marca como abstención toda respuesta inválida y solo cuenta las sugerencias de IA de incertidumbre baja y categoría permitida.

Con Ollama local ejecutándose y el modelo descargado, ejecuta:

```bash
PERSONAL_BUDGET_RUN_OLLAMA_ACCEPTANCE=1 OLLAMA_MODEL=qwen3:8b npm run test:ollama:acceptance
```

El test informa métricas agregadas y deltas por consola; no guarda prompts, ejemplos personales ni resultados fuera del proceso local. Es un ensayo de calidad sobre el modelo instalado, no una garantía de precisión universal. La métrica de tiempo y número de inferencias también se emite mediante la telemetría estructurada local existente, sin texto de prompts, categorías, beneficiarios ni importes.

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
