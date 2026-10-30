# Objetivos de ahorro y compromisos futuros

La sección **Objetivos** complementa Planificación con metas de ahorro y una agenda mensual. La funcionalidad es local-first: los objetivos y compromisos se almacenan en el fichero local planning-data.json dentro de ACTUAL_DATA_DIR, fuera de las tablas de Actual Budget. No hay pagos automáticos, importación silenciosa de compromisos ni escritura de movimientos al crear, editar, pausar o borrar un objetivo.

## Funciones incluidas

- CRUD de objetivos con nombre, importe objetivo, saldo inicial, aportación mensual deseada y fecha límite.
- Supuestos de ingreso y gasto mensual por objetivo. Si se dejan vacíos, se utiliza la mediana del historial local de los últimos doce meses naturales.
- Comparador de escenario personalizado por objetivo: permite probar otra aportación e ingresos/gastos alternativos contra el objetivo guardado; la simulación es efímera y no modifica el registro.
- Compromisos manuales puntuales o recurrentes (mensuales, trimestrales y anuales), con fecha ancla, importe, entrada/salida y notas. Se pueden editar, pausar, reanudar y borrar.
- Agenda con vistas de lista y calendario, generadas desde el mismo conjunto de elementos. La interfaz distingue compromisos manuales, movimientos futuros ya registrados en Actual y candidatos recurrentes no confirmados.
- Resumen de objetivos en el dashboard, tabla mensual por objetivo, avisos de alcanzabilidad y acción explícita para borrar la planificación local.

## Modelo y seguridad de almacenamiento

La API valida y versiona el fichero (version: 1), limita el número de objetivos/compromisos y el tamaño máximo de los datos, y escribe mediante archivo temporal exclusivo y renombrado atómico. El fichero y directorio se crean con permisos restrictivos (0600/0700 cuando el sistema de archivos los admite). Las mutaciones se serializan dentro del proceso para evitar pérdidas por escrituras concurrentes.

Los importes persistidos son enteros en unidades monetarias menores (por ejemplo, céntimos); las fechas son fechas civiles YYYY-MM-DD. Cada objetivo y compromiso guarda la divisa de análisis y una referencia al ámbito de cuentas vigentes al crearlo o editarlo. Si cambia la divisa o el ámbito global, se avisa y el registro se excluye de las proyecciones hasta que el usuario lo edite para confirmar el nuevo contexto. No se mezclan divisas diferentes ni se infiere una tasa de cambio.

La ruta POST /api/v1/planning/reset exige el literal de confirmación DELETE_PLANNING_DATA y solo elimina objetivos y compromisos locales; no restablece preferencias de la aplicación ni borra datos de Actual.

## Cómo interpretar las proyecciones

- El historial se calcula con finance-core, sobre el ámbito de cuentas seleccionado y después de convertir los movimientos que dispongan de una tasa aplicable. La API conserva avisos de importes no convertidos.
- Se incluyen doce meses naturales, incluso los meses sin movimientos, que cuentan como cero para la mediana. Se excluyen traspasos internos y el libro normalizado evita contar el padre y las partes de un movimiento dividido a la vez.
- La aportación empieza en el siguiente mes natural completo. El flujo mensual parte de la mediana observada (o de los supuestos que indique el usuario), ajustada por los compromisos manuales activos que coincidan en divisa y ámbito.
- La aportación efectiva de cada mes no supera ni la aportación deseada ni el efectivo estimado disponible después de compromisos. Se calcula también una capacidad máxima teórica sin comprometer todo el efectivo a otros usos; no representa dinero reservado ni garantiza el resultado.
- La aportación mensual necesaria para cerrar la brecha se estima como el importe pendiente dividido entre los meses disponibles, redondeado al alza en unidades menores. Si no quedan meses completos, se informa como no calculable salvo que el objetivo ya esté alcanzado.
- No se aplica interés, rentabilidad, inflación ni cambio automático de supuestos. Los candidatos de recurrencia no se suman al flujo ni se convierten en compromisos sin confirmación manual.
- Los movimientos futuros ya registrados en Actual se muestran identificados como movimientos reales. No se duplican automáticamente como compromiso manual ni se suman por separado a la proyección, que utiliza el historial mensual y los compromisos manuales; revisa posibles duplicados antes de añadir un compromiso que ya esté registrado como transacción.

Las cifras son estimaciones deterministas, no asesoramiento financiero ni garantía de que haya efectivo disponible. Un saldo inicial puede ser una cantidad declarada por el usuario y no se verifica contra una cuenta concreta.

## Agenda y API

- GET /api/v1/planning?month=YYYY-MM: devuelve ámbito/divisa, estimación histórica, objetivos con proyecciones/avisos, compromisos y elementos de agenda para el mes.
- POST /api/v1/planning/goals, PUT /api/v1/planning/goals/:id, PATCH /api/v1/planning/goals/:id/status, DELETE /api/v1/planning/goals/:id.
- POST /api/v1/planning/goals/:id/simulate: calcula otro escenario con aportación/ingreso/gasto explícitos sin persistirlo.
- POST /api/v1/planning/commitments, PUT /api/v1/planning/commitments/:id, PATCH /api/v1/planning/commitments/:id/status, DELETE /api/v1/planning/commitments/:id.
- POST /api/v1/planning/reset: requiere confirmación exacta.

## Copias de seguridad

**planning-data.json está excluido del backup cifrado actual de Actual.** scripts/actual-backup.ts empaqueta el directorio configurado por ACTUAL_SERVER_DATA_DIR (por defecto .local/actual-server-data), mientras que las preferencias y la planificación de esta aplicación se guardan en ACTUAL_DATA_DIR (por defecto .local/actual-api). Por tanto, que npm run backup:actual termine correctamente no implica que los objetivos se hayan respaldado. Si quieres conservarlos, incluye el fichero en un procedimiento local de copia separado, con protección equivalente de acceso y confidencialidad. No lo subas al repositorio ni a un servicio externo.

## Pruebas

Las pruebas usan repositorios y fechas sintéticos. Cubren meses sin movimientos, transferencias excluidas, recurrencias ancladas a fin de mes, objetivos alcanzados o inalcanzables, aportaciones limitadas por flujo, fechas/importes inválidos, persistencia entre instancias, CRUD, cambios de divisa/ámbito, y separación de la agenda respecto de los movimientos reales.


## Planificador conversacional

La capa conversacional de #70 reutiliza este almacenamiento y el motor de proyección, pero no persiste cambios. Puede seleccionar un objetivo existente compatible y probar aportaciones o gastos hipotéticos; un objetivo nuevo se presenta como hipótesis y no se crea en `planning-data.json`. Los compromisos reales y guardados permanecen intactos. Para guardar o modificar objetivos y compromisos, el usuario debe usar las acciones separadas de esta sección y revisar la previsualización disponible.
