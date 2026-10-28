# Movimientos e importaciones bancarias

## Formatos admitidos

Actual Budget documenta la importación de CSV, QIF, OFX, QFX y CAMT. La compatibilidad real depende del banco, del formato descargado y de cómo esté construido el archivo. OFX/QFX se recomiendan cuando el banco los ofrece. Fuente: [Importing Transactions — Actual Budget](https://actualbudget.org/docs/transactions/importing/).

## Flujo recomendado

1. Entra en la web oficial de tu banco.
2. Exporta el periodo de movimientos que quieras importar. No entregues tu contraseña bancaria a `personal-budget`.
3. Abre la cuenta correspondiente en Actual Budget y utiliza la opción de importación.
4. Para CSV, revisa el mapeo de columnas, el formato de fecha, el separador decimal y el signo del importe en la vista previa.
5. Comprueba que ingresos y gastos no hayan quedado invertidos.
6. Revisa duplicados y compara el saldo final con el banco.
7. Clasifica las operaciones que sigan sin categoría.

No existe garantía de compatibilidad universal con todos los formatos propietarios. En algunos casos habrá que convertir el extracto a CSV y revisar el mapeo.

## Reglas para evitar errores

- Haz una copia de seguridad antes de una importación masiva.
- Empieza con un periodo pequeño y contrasta varios movimientos.
- No abras ni ejecutes macros de archivos bancarios; usa exportaciones del banco y herramientas de confianza.
- No guardes extractos en el repositorio Git.
- Comprueba si el fichero contiene cargos y abonos en columnas separadas.
- Evita importar dos veces el mismo periodo. Actual intenta detectar duplicados, pero la detección no es infalible.
- Tras importaciones grandes, compara los saldos por cuenta y revisa un conjunto representativo de transacciones.

## Importación de datos en `personal-budget`

La importación CSV de la aplicación mantiene el mapeo de columnas existente. La importación OFX propia está limitada a SGML 1.02/1.03 y XML OFX 2.x, y se procesa en el navegador. Para límites, codificaciones, deduplicación y divisas, consulta la [guía de importación OFX](ofx-import.md). Los demás formatos admitidos por Actual no están habilitados en el flujo propio. La app debe usar el flujo de Actual o llamar a sus operaciones soportadas mediante `@actual-app/api`; no debe modificar archivos internos, SQLite de Actual ni ficheros de sincronización. Actual continúa siendo la fuente de verdad.

## Exportación local de movimientos e informes

En Movimientos, aplica el periodo y los filtros deseados y pulsa Preparar exportación. La previsualización muestra periodo, ámbito de cuentas guardado, cuenta/categoría, búsqueda, filtro de movimientos sin categoría y número exacto de registros. La descarga requiere una segunda acción explícita. Se consultan todas las páginas filtradas, no solo la página visible; por seguridad la interfaz limita cada exportación a 10.000 movimientos.

- CSV: UTF-8 con BOM, separador punto y coma, comillas dobles escapadas, registros CRLF y fechas ISO AAAA-MM-DD. Los importes se representan como enteros en unidades menores (importe_minor), con divisa nativa y, si existe, importe/divisa de análisis y metadatos de conversión. Las columnas de texto neutralizan prefijos que algunas hojas de cálculo interpretarían como fórmulas.
- JSON: incluye esquema/versionado, filtros, marca temporal, IDs de movimiento/cuenta/categoría, vínculos de transferencia y desglose disponibles, importes nativos/de análisis y metadatos de conversión devueltos por la API.
- Informes: CSV y JSON documentan periodo actual/comparado, ámbito de cuentas, divisa de análisis, tasas utilizadas y advertencias. Si las divisas de los periodos no coinciden, se omiten las variaciones monetarias. Los importes agregados se exportan como valores calculados por la API, en unidades menores, sin volver a calcularlos en el navegador.
- Si no hay resultados o la API devuelve una consulta incompleta, no se genera ningún archivo engañoso. La exportación es de solo lectura y sucede en el navegador; no sube archivos, no usa telemetría y no sustituye un backup completo de Actual Budget. No incluye necesariamente preferencias, configuración, historial ni datos privados que la API no exponga.

## Datos que no deben compartirse
Los CSV, OFX, QFX, QIF, CAMT y las bases de datos de presupuestos pueden revelar hábitos, ingresos, comercios, ubicaciones y obligaciones financieras. Trátalos como datos altamente sensibles. No los adjuntes a issues, commits ni conversaciones de soporte.


## Rendimiento y límites de historiales

GET /api/v1/transactions filtra por cuenta y fechas en el límite del repositorio, y conserva el contrato paginado por limit/offset. La API oficial de @actual-app/api usa getTransactions(accountId, startDate, endDate) y no expone limit, offset ni cursor. No se debe presentar la paginación actual como paginación ejecutada por la base de datos de Actual ni leer/escribir su base de datos por vías no oficiales.

La API procesa como máximo **100.000 movimientos presentados por petición** (los hijos de splits cuentan como filas presentadas). Una consulta que exceda el límite devuelve HTTP 422 con TRANSACTION_QUERY_TOO_BROAD; reduce el intervalo de fechas o selecciona una cuenta. La respuesta mantiene el total exacto dentro de ese presupuesto. Para reducir memoria adicional, los movimientos se procesan cuenta por cuenta y una selección de tamaño offset + limit conserva los candidatos que corresponden a la página, en lugar de materializar listas intermedias completas y ordenar todos los resultados. El orden incorpora un desempate determinista por ID.

El endpoint consulta el periodo solicitado en **ventanas secuenciales por mes natural** y deja de pedir meses posteriores cuando agota el presupuesto de 100.000 movimientos presentados. Esto evita materializar a la vez el resultado de todo un periodo de varios años, sin alterar el orden global, los filtros o la semántica de los splits. El SDK sigue materializando las filas de cada mes individual: un solo mes excepcionalmente denso aún puede causar un pico de memoria elevado, y esta estrategia no equivale a paginación por cursor dentro de Actual. No se introduce una caché ni una base financiera paralela sin evidencia de perfilado.

Para reproducir medidas sintéticas (10.000, 50.000 y 100.000 filas; tres repeticiones por tamaño), ejecuta desde la raíz después de instalar dependencias:

npx vitest run services/api/tests/app.test.ts -t "records a reproducible bounded-page benchmark" --reporter=verbose

La prueba registra la versión de Node, la mediana de latencia, el máximo incremento observado de heap y las llamadas al repositorio por petición. Además aplica techos de regresión deliberadamente holgados para cada tamaño: mediana por debajo de 3 s y aumento observado de heap inferior a 128 MiB; son umbrales de CI derivados con margen del benchmark sintético, no objetivos de latencia real ni una medición del trabajo interno de Actual.
