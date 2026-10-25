# Guía de uso

Esta guía describe la interfaz implementada: Resumen, Movimientos, Informes, Presupuestos, Planificación, Asistente y Configuración. Los ejemplos de la documentación no representan datos reales.

## 1. Dashboard

El dashboard debe mostrar el periodo seleccionado y permitir cambiar entre día, mes, año y un intervalo personalizado. Los indicadores principales son:

- Ingresos del periodo.
- Gastos del periodo.
- Ahorro neto del periodo.
- Tasa de ahorro, cuando el denominador sea válido.
- Presupuesto frente a gasto real, si hay presupuestos configurados.
- Gastos por categoría.
- Evolución de ingresos, gastos y ahorro.

Cada indicador debe mostrar la divisa y el intervalo exacto. Los ejemplos de la documentación no representan datos reales.

## 2. Registrar un movimiento

El formulario previsto incluye fecha, importe, divisa, cuenta, descripción, categoría y tipo de movimiento. Debe distinguir gasto, ingreso, traspaso, reembolso y ajuste cuando proceda.

Antes de guardar, valida que la fecha tenga un formato correcto, el importe sea válido, la cuenta exista y la operación no parezca duplicada. La interfaz debe mostrar una confirmación clara si el movimiento va a modificar Actual Budget.

## 3. Categorías

Empieza con categorías que puedas mantener con consistencia. Ejemplo:

- Vivienda y suministros.
- Alimentación y supermercado.
- Transporte.
- Restaurantes y ocio.
- Salud y cuidado personal.
- Compras y hogar.
- Suscripciones.
- Viajes.
- Comisiones e intereses.
- Ingresos.
- Transferencias (no computan como gasto consolidado).
- Sin clasificar.

Las categorías concretas deben poder adaptarse a las del presupuesto de Actual.

## 4. Informes

### Diario

Lista de movimientos y total por cuenta. El saldo disponible debe proceder de la cuenta de origen, no inferirse sumando movimientos parciales sin conocer su saldo inicial.

### Mensual

Compara ingresos, gastos, ahorro y categorías con el mes anterior. Muestra tanto el cambio absoluto como el porcentaje cuando el cálculo tenga sentido.

### Anual

Muestra los doce meses y la distribución anual por categorías. Permite comparar años y consultar si el cambio proviene de ingresos, consumo, gastos excepcionales o transferencias.

## 5. Planificación

La sección Planificación reúne las mejoras P3 (detalles en [planning.md](planning.md)):

- **Pagos recurrentes:** candidatos detectados con señales deterministas, con explicación de cadencia e importe y avisos de falso positivo. Son candidatos, no garantías.
- **Sugerencias de categoría:** movimientos sin clasificar con evidencia histórica del mismo beneficiario; puedes editar la categoría, aplicar o descartar cada una, o aplicar todas con confirmación. La previsualización no escribe; el commit es explícito.
- **Previsión:** escenarios de reducción por categoría o cambio de ingreso con horizonte en meses; separa recurrente de extraordinario, muestra supuestos y avisos, y se marca como estimación sin tocar el presupuesto real.

## 6. Chat financiero

El chat responde a partir de resultados calculados por el backend. Las cifras proceden de finance-core y la narración del modelo es cualitativa, separada y saneada. Las solicitudes que cambiarían datos no se ejecutan desde el chat; los cambios se hacen desde Movimientos o Planificación con previsualización y confirmación.

## 7. Interpretar los resultados

- El gasto consolidado excluye traspasos entre cuentas propias.
- Un movimiento sin categoría aparece como «Sin clasificar».
- Los resultados de distintas divisas no se suman sin conversión declarada.
- Una previsión no es una garantía y debe exponer sus supuestos.
- Si faltan datos o la consulta es ambigua, el asistente debe pedir el periodo/cuenta/categoría que falta o informar de la limitación.

## 8. Revisión semanal sugerida

1. Importar movimientos recientes.
2. Revisar duplicados y conciliación con el saldo bancario.
3. Abrir Planificación y clasificar operaciones pendientes con las sugerencias.
4. Consultar las categorías con mayor desviación del presupuesto.
5. Verificar que el ahorro mensual excluye traspasos y no contabiliza dos veces el mismo dinero.
