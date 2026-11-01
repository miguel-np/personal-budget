# Patrimonio externo, justificantes y portabilidad

## Límites de autoridad y procedencia

Actual Budget sigue siendo la fuente de verdad para cuentas, movimientos y presupuestos. Personal Budget añade tres conjuntos locales separados:

- **Clasificación patrimonial de cuentas Actual:** solo etiqueta una cuenta existente como activo o pasivo; no cambia su saldo ni la cuenta en Actual.
- **Activos y pasivos externos:** inmuebles, vehículos, carteras, efectivo externo, préstamos, hipotecas y otros elementos que no aparecen como cuenta de Actual.
- **Justificantes:** binarios privados y metadata local que pueden vincularse a un movimiento existente, sin modificarlo.

Una valoración manual no es un movimiento ni una operación de inversión. El sistema no infiere rentabilidad, rendimiento fiscal, valor de mercado ni disponibilidad de efectivo. Cada cifra conserva fecha, divisa y procedencia. Las valoraciones se añaden como snapshots: no hay una operación que permita editar o borrar un snapshot aislado. Para corregirlo, añade una valoración posterior o elimina explícitamente el elemento completo y su historial.

## Contrato de persistencia patrimonial

El archivo wealth-data.json usa version: 1 e incluye:

- Configuración explícita: antigüedad máxima de valoración (30–365 días, 90 por defecto) e inclusión o no de cuentas fuera de presupuesto.
- Clasificación asset/liability por ID de cuenta Actual. No se deduce a partir del nombre o signo del saldo.
- Elementos externos con UUID, tipo, nombre, propietario/notas, divisa, estado activo/archivado y referencia opcional a una cuenta Actual duplicada.
- Historial de snapshots con UUID, fecha civil, importe en unidades monetarias menores, divisa, fuente y notas. Cuando se facilita cantidad y precio unitario, el importe se calcula de forma determinista con aritmética entera y redondeo half-up a unidades menores.

El archivo se valida con Zod, límites de tamaño y cardinalidad, IDs únicos, clasificación de tipos, importes enteros seguros y coincidencia entre divisa del elemento y de cada snapshot. Las escrituras usan fichero temporal, permisos 0700/0600, rename y un lock serializado por directorio dentro del proceso API.

Un elemento vinculado a una cuenta de Actual queda excluido automáticamente del patrimonio externo. No se permite que el mismo ID de cuenta aparezca vinculado a más de un elemento local. Este vínculo es una referencia para evitar doble cómputo; no crea ni reconcilia cuentas.

## Contrato del patrimonio consolidado

GET /api/v1/wealth/summary consolida los saldos de las cuentas Actual incluidas en el ámbito global con el último snapshot elegible de cada elemento externo:

- Las cuentas Actual requieren clasificación explícita, saldo conocido y conversión válida.
- La conversión usa solo los tipos de cambio locales cuya fecha efectiva sea igual o anterior a la fecha del saldo/valoración. No se consultan tipos de cambio ni precios externos.
- Cada valoración tiene una fecha de vigencia. Si falta, está fuera del periodo configurable o no tiene conversión fechada, el patrimonio neto consolidado se marca incomplete y netWorthMinor pasa a null; no se presenta un total parcial como si fuera completo.
- Activos y pasivos se muestran por separado. El patrimonio neto descuenta pasivos con signo. Efectivo externo se identifica como liquidez separada, pero no se interpreta como saldo presupuestario ni como dinero automáticamente disponible.
- Elementos archivados, duplicados por Actual o excluidos expresamente no contribuyen al total y se identifican en la cobertura.

No se debe confundir el patrimonio neto con el saldo de caja, la liquidez disponible, el valor de compra o la rentabilidad.

## Contrato de justificantes

El archivo documents-index.json usa version: 1. Los binarios viven fuera del directorio público de Vite, en ACTUAL_DATA_DIR/documents/. Cada nombre se genera en servidor como UUID.pdf, UUID.jpg o UUID.png; el nombre original no forma parte de la ruta.

- Tamaño máximo por archivo: 10 MiB; máximo de 2.000 documentos y 100 vínculos por documento.
- Se admiten solo firmas PDF, JPEG y PNG; no se confía en el nombre ni en el MIME enviado por el navegador.
- El fichero usa permisos privados 0600 y el directorio 0700. La metadata conserva tamaño, SHA-256, tipo detectado, fecha, emisor, importe/divisa opcionales, clasificación, tags, notas y estado de revisión.
- Los estados pending, reviewed e incomplete son decisiones manuales. No hay OCR, extracción fiscal automática ni envío remoto a IA.
- Los vínculos guardan ID de movimiento, cuenta y fecha. Antes de guardarlos, el servidor vuelve a leer el movimiento en Actual y exige que coincidan los tres campos. No escribe ni altera el movimiento.
- Archivar conserva archivo, metadata y vínculos. El borrado exige confirmación y elimina el índice y el binario; no equivale a archivar. La eliminación no es una función de retención automática.

El inventario de backup valida que no existan binarios huérfanos, rutas no generadas, enlaces simbólicos, tamaños distintos o hashes/firmas inconsistentes. Un índice o carpeta incoherentes provocan que el backup falle en lugar de omitir evidencia.

## API y portabilidad

- GET/POST/PATCH/DELETE /api/v1/wealth/assets gestiona elementos externos.
- POST /api/v1/wealth/assets/:id/valuations añade un snapshot inmutable.
- PATCH /api/v1/wealth/assets/:id/status archiva/reactiva; DELETE exige confirmación.
- PUT /api/v1/wealth/accounts/:accountId/classification guarda clasificación Actual explícita.
- GET/POST/PATCH /api/v1/documents, PUT /api/v1/documents/:id/links, descarga, archivado y borrado gestionan la custodia local.
- GET /api/v1/portable-export requiere conjuntos de datos explícitos. El JSON lleva formato/versión, fecha, contexto de divisa/ámbito, manifiesto por conjunto, procedencia, recuentos, limitaciones y exclusiones. Incluye planificación, preferencias, alertas/decisiones, revisiones, patrimonio y documentos; también puede exportar meses concretos de presupuestos accesibles en Actual.
- Los binarios documentales solo se incluyen si se solicitan expresamente y el total no supera 20 MiB. En otro caso se exportan únicamente metadata y vínculos.
- Movimientos e informes no se duplican en este JSON; siguen disponibles en sus exportadores CSV/JSON/XLSX existentes. Los CSV existentes protegen las celdas de texto frente a fórmulas.

La exportación portable es una instantánea humana, no importable ni restaurable. No contiene secretos, claves, contraseñas, logs, rutas privadas o configuración del entorno. La recuperación integral se hace con el backup cifrado unificado.

## Backup y compatibilidad

El backup schemaVersion: 2 incorpora wealth-data.json, documents-index.json y todos los binarios validados en personal-budget-state/documents/, inventariados individualmente con nombre, tamaño y SHA-256. El flujo de restore valida metadata y binarios antes de sustituir estado, y conserva una instantánea de rollback.

Las copias antiguas schemaVersion: 1 siguen siendo válidas. Como no contienen el patrimonio externo ni los documentos locales nuevos, restaurarlas preserva el estado de patrimonio/documentos existente en lugar de borrarlo silenciosamente. Solo una copia v2 puede restaurar de forma integral estos conjuntos.

La aceptación sintética de backup siembra y recupera nueve JSON, una valoración y un PDF, ejecuta los lectores de producción y comprueba el hash y el contenido binario. No sustituye a una restauración de ensayo en un entorno aislado con las claves reales custodiadas por separado.
