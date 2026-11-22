# Guía práctica de uso

Esta guía explica cómo orientarte en Personal Budget y cómo interpretar sus resultados. Para conocer todas las capacidades y limitaciones, consulta el [catálogo de funcionalidades](features.md).

## Antes de utilizarla

- Actual Budget debe estar iniciado y el presupuesto debe estar configurado.
- Comprueba que el ámbito de cuentas y la divisa son los correctos.
- Recuerda que Actual es la fuente de verdad de cuentas, movimientos, categorías y presupuestos.
- No confundas una estimación con un saldo bancario disponible.

## Recorrido recomendado

### 1. Resumen: entiende el periodo

Abre **Resumen**. Comprueba el intervalo de fechas, las cuentas incluidas y la divisa. Revisa ingresos, gastos, ahorro neto y distribución por categorías.

Si un total no coincide con tus expectativas, comprueba primero:
- Que estás mirando el mismo periodo.
- Que el ámbito de cuentas es el esperado.
- Que los movimientos tienen divisa conocida y conversión válida.
- Que los traspasos entre cuentas propias no se están interpretando como gasto o ingreso.

### 2. Cuentas: elige el ámbito del análisis

Abre **Cuentas** y comprueba qué cuentas están abiertas, cerradas o fuera de presupuesto. La preferencia de ámbito permite analizar todas las cuentas abiertas o una selección.

Una selección vacía representa cero cuentas. Si una cuenta seleccionada deja de existir o se cierra, la aplicación puede pedirte que revises la selección en lugar de ampliar el ámbito silenciosamente.

### 3. Movimientos: consulta y registra operaciones

Utiliza los filtros de periodo, cuenta y categoría para localizar operaciones. Antes de crear o editar un movimiento, comprueba la cuenta, fecha, importe, divisa, categoría y tipo.

Las operaciones que escriben en Actual requieren una acción explícita. Para importaciones CSV/OFX:
1. Exporta el fichero desde la web de tu banco; no entregues credenciales bancarias a Personal Budget.
2. Abre la importación desde Movimientos y selecciona el fichero local.
3. Revisa el resultado de la previsualización, los signos de importes, las fechas, las cuentas y los posibles duplicados.
4. Corrige o cancela si hay datos incorrectos.
5. Confirma solo cuando el conjunto sea correcto.

Consulta [Movimientos e importaciones](transactions-and-imports.md) y [perfiles OFX](ofx-import.md) antes de importar un historial grande. Haz un backup previo.

### 4. Presupuestos: compara lo previsto con lo observado

Revisa la asignación de cada categoría y el gasto del periodo. Las alertas locales señalan umbrales configurados; no cambian asignaciones ni envían notificaciones fuera de la aplicación.

Si una categoría no tiene presupuesto conocido, no interpretes ese dato como presupuesto cero.

### 5. Informes: compara y exporta

Selecciona un periodo y revisa el periodo de comparación, el ámbito de cuentas y la divisa. Comprueba que la comparación utiliza intervalos equivalentes.

En la exportación:
- PDF: se abre una vista imprimible; selecciona «Guardar como PDF» en el diálogo del navegador.
- XLSX: genera un libro de Excel con hojas de resumen y categorías; el anexo de movimientos es opcional cuando está disponible.
- CSV/JSON: sirven para consultar o procesar los datos exportados.

Un informe exportado no es un backup restaurable.

### 6. Planificación: revisa candidatos y simulaciones

En **Planificación** puedes revisar posibles pagos recurrentes, sugerencias de categoría y previsiones.

- Verifica manualmente cada pago recurrente candidato con el contrato o extracto correspondiente.
- Comprueba la evidencia de una sugerencia de categoría antes de aplicarla.
- Lee los supuestos y advertencias de una previsión antes de utilizarla para planificar.

Una previsualización no escribe datos. Cuando una operación requiere confirmación, revisa el cambio antes de aplicarlo.

### 7. Inteligencia financiera y Revisión financiera

En **Inteligencia financiera**, abre cada hallazgo y lee la regla, el periodo y la evidencia. Una variación no explica por sí sola su causa.

En **Revisión financiera**, selecciona una revisión semanal o mensual y comprueba si el periodo está completo. La revisión se genera bajo demanda; no crea recordatorios ni tareas en segundo plano.

### 8. Objetivos y Patrimonio

En **Objetivos**, registra metas de ahorro y compromisos que hayas verificado. Los objetivos y simulaciones no ejecutan pagos ni crean movimientos en Actual.

En **Patrimonio y documentos**, registra activos, pasivos, valoraciones y justificantes con fecha y procedencia. Una valoración manual no es un precio de mercado garantizado. Protege los documentos y realiza backups.

### 9. Asistente e integraciones opcionales

El **Asistente** requiere Ollama local y está desactivado por defecto. Si no lo has configurado, puedes utilizar las funciones financieras sin él.

La investigación web es independiente y requiere consentimiento por consulta. MCP requiere un cliente compatible y expone herramientas de lectura/simulación. Lee [privacidad](privacy.md), [IA local](local-ai.md), [búsqueda web](web-search.md) y [MCP](mcp.md) antes de activarlos.

## Cómo interpretar los resultados

- **Ingresos y gastos:** dependen del periodo y de las reglas de clasificación.
- **Transferencias internas:** no son ingresos ni gastos consolidados.
- **Sin clasificar:** significa que el movimiento carece de categoría; no significa que su importe sea cero.
- **Multidivisa:** solo se agregan importes con divisa conocida y conversión válida. Las tasas son manuales/locales.
- **Recurrente candidato:** es un patrón observado, no una obligación confirmada.
- **Previsión o flujo de caja:** es una estimación basada en datos disponibles y supuestos, no una garantía.
- **Patrimonio:** puede ser incompleto si faltan clasificaciones o valoraciones.
- **IA:** las cifras calculadas por backend deben distinguirse de la explicación cualitativa del modelo.

## Rutina semanal sugerida

1. Importa los movimientos recientes en Actual o mediante el flujo local compatible.
2. Revisa duplicados y concilia los movimientos con tus registros.
3. Clasifica las operaciones pendientes.
4. Comprueba las categorías con mayor desviación presupuestaria.
5. Revisa los pagos recurrentes candidatos y los compromisos próximos.
6. Actualiza objetivos y valoraciones patrimoniales cuando corresponda.
7. Comprueba que existe un backup reciente y que conservas su clave.

## Si algo no cuadra

No cambies datos al azar. Comprueba periodo, cuenta, categoría y divisa; después revisa [Resolución de problemas](troubleshooting.md). No compartas movimientos reales, saldos ni documentos para solicitar ayuda.
