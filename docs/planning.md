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
