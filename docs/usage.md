# Guía de uso

Esta guía describe el comportamiento previsto de la interfaz. Las pantallas se implementarán en el código futuro; el paquete actual no incluye la aplicación ejecutable.

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

## 5. Chat financiero

El chat debe aceptar preguntas en lenguaje natural y responder a partir de resultados obtenidos de herramientas autorizadas. Ejemplos:

- «¿Cuánto gasté en supermercado el último mes?»
- «Compara mi gasto en transporte en los últimos seis meses».
- «¿Qué categorías han aumentado más este año?»
- «Calcula un escenario en el que reduzco ocio un 10 %».
- «Prepara un gasto de 28,50 € en transporte para hoy».

Las preguntas de lectura pueden ejecutarse directamente. Las solicitudes que cambien datos deben generar una vista previa con los campos completos y esperar confirmación explícita. El chat no debe inferir que el usuario ha confirmado solo porque el mensaje sea ambiguo.

## 6. Interpretar los resultados

- El gasto consolidado excluye traspasos entre cuentas propias.
- Un movimiento sin categoría aparece como «Sin clasificar».
- Los resultados de distintas divisas no se suman sin conversión declarada.
- Una previsión no es una garantía y debe exponer sus supuestos.
- Si faltan datos o la consulta es ambigua, el asistente debe pedir el periodo/cuenta/categoría que falta o informar de la limitación.

## 7. Revisión semanal sugerida

1. Importar movimientos recientes.
2. Revisar duplicados y conciliación con el saldo bancario.
3. Clasificar operaciones pendientes.
4. Consultar las categorías con mayor desviación del presupuesto.
5. Verificar que el ahorro mensual excluye traspasos y no contabiliza dos veces el mismo dinero.
