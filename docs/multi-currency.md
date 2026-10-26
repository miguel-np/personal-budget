# Divisas, conversión y trazabilidad

## Principios

- Actual Budget sigue siendo la fuente de verdad; cambiar la divisa de análisis no escribe movimientos ni cambia IDs en Actual.
- La divisa que se muestra, la divisa nativa del importe y la divisa propia del presupuesto de Actual son conceptos distintos.
- Se usa una divisa nativa devuelta por Actual o una asignación explícita local por cuenta. Si ambas faltan, el importe original se conserva y se señala como desconocido; no se le atribuye EUR ni otra divisa por inferencia.
- Los agregados solo incorporan movimientos cuya moneda de origen es conocida y que se pueden convertir a la divisa de análisis. Los importes no convertibles se informan en unconvertedTransactionCount y en warnings, pero no se añaden a ingresos, gastos, ahorro ni categorías.
- Las tasas de cambio son manuales/locales. No hay petición a proveedores de cambio ni dependencia de servicios externos.

## Preferencias persistidas

La API conserva las preferencias en currency-preferences.json bajo ACTUAL_DATA_DIR (por defecto .local/actual-api), con escritura atómica y permisos restrictivos en sistemas que los soportan. El archivo no contiene movimientos financieros.

- displayCurrency: divisa de consolidación y presentación; el valor inicial es EUR.
- accountCurrencyOverrides: asignación explícita de una moneda a una cuenta cuando Actual no aporta metadatos suficientes. Una moneda que Actual sí proporciona tiene prioridad; la API rechaza un override que la contradiga.
- exchangeRates: pares origen/destino, tasa positiva decimal, fecha civil desde la que aplica y campo source que identifica la procedencia (por ejemplo, manual, estado de cuenta o referencia de la que se copió la tasa).

No cambies la divisa nativa dentro de Actual para simular una preferencia de presentación. Borrar un override vuelve a dejar la moneda nativa desconocida si el origen no la proporciona. No añadas el archivo local ni exportes datos reales al repositorio.

## Cálculo

- Los importes se almacenan y agregan en unidades menores enteras. El tipo de cambio se interpreta como unidades de destino por unidad de origen; el algoritmo usa aritmética racional y redondeo determinista al entero más cercano, con los empates alejándose de cero.
- Un movimiento usa la tasa de la pareja de divisas con la fecha efectiva más reciente que no supere la fecha del movimiento. Se admite la tasa inversa cuando la pareja está guardada al revés; la respuesta registra inverseRate para que sea visible.
- La respuesta del resumen incluye la divisa de análisis, movimientos no convertidos y exchangeRatesUsed: par, tasa, fecha, fuente, sentido de conversión y cantidad de transacciones que la usaron.
- Reembolsos conservan el signo del movimiento. Una tasa positiva conserva el signo al convertir un cargo negativo o una devolución positiva.
- Los movimientos divididos se normalizan a sus submovimientos; no se suma el total padre otra vez. Cada hijo hereda la divisa de su movimiento padre solo si el hijo no contiene una propia.
- Los traspasos internos siguen excluidos del cálculo de ingresos y gastos consolidados, independientemente de la moneda; no se tratan como ingreso ni gasto en ninguna de sus dos patas. Si se investigan saldos de cuentas, cada saldo permanece asociado a la moneda nativa y su conversión se presenta separadamente.
- Las tasas que falten, sean futuras respecto a la fecha del movimiento o no estén bien formadas no se inventan ni se sustituyen por la tasa actual.

## Presupuestos de Actual

Los presupuestos por categoría, las asignaciones y el disponible de Actual siguen expresados en la divisa propia del presupuesto; cambiar displayCurrency no convierte ni reescribe las asignaciones en Actual. La interfaz de Presupuestos usa la divisa de presupuesto y debe interpretarse en ese contexto, aunque los informes y el dashboard usen otra. No se deben comparar importes de gasto convertidos contra un presupuesto nativo sin convertir explícitamente también el presupuesto y advertir sobre el tratamiento de arrastres/asignaciones.

## Formato regional

El formato regional predeterminado sigue siendo es-ES (coma decimal, separador de miles y fechas legibles de España). La localización de una cifra no determina su moneda. Las fechas de transacciones se manejan como fechas civiles YYYY-MM-DD, no como instantes UTC que deban cambiar de día al renderizarse.

## Pruebas y límites de aceptación

Los tests unitarios y de API usan datos sintéticos y cubren tasas históricas, tasa inversa, signos negativos/positivos, divisa desconocida, falta de tasa, tasas manuales persistidas, conversiones y ausencia de consolidación sin tasa. La CI no usa cuentas reales ni proveedores externos.

La integración con las propiedades de moneda que proporcione cada versión real de la API de Actual debe comprobarse contra una instancia sintética. Si una versión no expone moneda por cuenta/transacción, el usuario debe asignarla explícitamente en Configuración; el adaptador no supone que exista un campo ni lo fabrica.
