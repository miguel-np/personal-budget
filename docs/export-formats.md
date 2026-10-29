# Exportación local de informes y movimientos

Personal Budget genera los archivos en el navegador local. Las exportaciones no modifican Actual Budget ni el estado de Personal Budget y no envían el contenido a conversores remotos.

## Informes

En **Informes del periodo → Exportar informe**:

- **Imprimir / Guardar como PDF** abre una vista imprimible independiente con los periodos actual y comparado, ámbito de cuentas, métricas, ingresos y gastos por categoría, tipos de cambio declarados y advertencias. En el diálogo de impresión del navegador, selecciona **Guardar como PDF**. El contenido se construye localmente y no carga fuentes, scripts ni servicios externos. Si el navegador bloquea ventanas emergentes, permite la apertura para Personal Budget y repite la acción.
- La casilla opcional **Incluir anexo con movimientos del periodo actual en PDF/XLSX** añade un anexo separado, con página apaisada para PDF. Se consulta el periodo actual, no el periodo comparativo; se respeta el ámbito de cuentas y se verifica el total, la unicidad de identificadores y la integridad de las páginas. Si no es posible comprobar el conjunto completo, no se produce el archivo.
- **Excel (XLSX)** crea un libro con hojas Resumen, Gastos por categoría e Ingresos por categoría, encabezados, filtros en tablas de categorías y formatos de fecha/número. Si seleccionas el anexo, se añade una hoja Movimientos con celdas de fecha, importes nativos/convertidos separados y los identificadores que permiten rastrear transferencias y desgloses.
- **CSV y JSON** mantienen los contratos de exportación existentes.

## Movimientos

En **Movimientos → Selección y exportación → Preparar exportación**, la previsualización aplica el periodo, cuenta, categoría, búsqueda, filtro de movimientos sin categoría y orden que se muestran en pantalla. La exportación vuelve a consultar todas las páginas del conjunto, comprueba el total y los identificadores y no crea archivos si el resultado supera el límite o cambia durante la lectura.

- **XLSX** incluye las filas filtradas en la hoja Movimientos y una hoja Notas y criterios. Las fechas son celdas de fecha; los importes con precisión conocida son celdas numéricas expresadas en unidades principales de la divisa, con el valor entero original en unidades menores en una columna separada. Si falta la divisa o no se conoce su precisión, el importe en unidades principales queda vacío y se conserva el valor original en unidades menores; el libro cuantifica estos casos en la hoja de notas.
- **Imprimir / Guardar como PDF** crea un listado legible, con fecha, concepto, cuenta/categoría, importe nativo, importe de análisis y estado de conciliación. Para evitar generar documentos impracticablemente grandes, el PDF está limitado a 1.000 movimientos por exportación. Acota los filtros si se supera el límite.
- **CSV y JSON** siguen disponibles. CSV usa UTF-8 con BOM, separador punto y coma y protección frente a fórmulas; JSON mantiene identificadores, relaciones y metadatos de conversión.

El límite máximo para exportar movimientos a CSV/JSON/XLSX es de 10.000 registros. No hay truncamiento silencioso: si el resultado excede el límite, no se crea ningún archivo parcial y la interfaz explica cómo reducir el conjunto.

## Divisas y seguridad

Los archivos conservan por separado el importe nativo y el importe de análisis. El importe de análisis solo se incluye cuando la API proporciona una conversión válida. La exportación no inventa tipos de cambio y no rellena importes o conversiones desconocidas con cero. En XLSX, los campos suministrados como texto siempre se serializan como celdas de texto y nunca como fórmulas; los valores numéricos legítimos permanecen numéricos.

Los filtros, periodos, ámbito de cuentas, divisa y fecha de generación se muestran en la previsualización o en el propio archivo cuando corresponda. Una exportación no es un respaldo restaurable ni sustituye al procedimiento de backup/restore de Personal Budget. Los PDF son documentos de lectura/impresión, no informes financieros certificados ni asesoramiento profesional.
