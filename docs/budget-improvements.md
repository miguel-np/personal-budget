# Propuestas de mejora presupuestaria (#83)

## Diagnóstico

La vista usa los movimientos y categorías disponibles en Actual mediante el adaptador oficial; no solicita una segunda importación. El periodo de referencia puede ser de 3, 6 o 12 meses naturales completos. El mes en curso se excluye para evitar proyectar desde una ventana parcial. La respuesta declara corte, periodo, ámbito de cuentas, divisa, número de movimientos y conversiones no disponibles.

La línea base muestra ingresos, gastos y ahorro neto mensual observados. Los importes se calculan en `finance-core`; no se usan cifras devueltas por un modelo generativo.

## Preferencias personales

Cada categoría puede marcarse como:

- **Sin clasificar** (predeterminado).
- **Esencial**.
- **Protegida**.
- **Flexible**.
- **Revisable**.

No se deduce flexibilidad por el nombre de una categoría. Solo las categorías que la persona marque expresamente como flexibles o revisables pueden originar propuestas de reducción. Las categorías esenciales/protegidas y las no clasificadas quedan fuera de esas propuestas y simulaciones.

La prioridad elegida puede ser aumentar el margen mensual, reducir gasto variable, alcanzar una meta de ahorro o liberar flujo de caja. Se aplica al regenerar explicaciones de propuestas, pero no altera los importes calculados. Cuando se elige alcanzar una meta, la API reutiliza la proyección determinista de los objetivos ya guardados en Planificación. Muestra aportación necesaria, aportación actual, saldo proyectado, capacidad de caja y advertencias por divisa/ámbito; no crea una segunda fuente de objetivos ni modifica las metas al aceptar propuestas.

## Propuestas de la primera versión

Una propuesta solo se genera cuando existe una señal verificable en el último mes completo: exceso frente a una asignación presupuestaria positiva o aumento frente a la media de los meses anteriores. Además, requiere al menos tres movimientos, actividad en dos meses y clasificación explícita como flexible/revisable. El porcentaje sugerido se deriva de la señal observada, no de un porcentaje universal. La confianza es una etiqueta cualitativa basada en longitud y cobertura del historial, no una probabilidad.

Cada propuesta aporta categoría, explicación, señal de origen (`budget_overrun` o `recent_increase`), importes observados que sustentan la señal, periodo, número de movimientos, regla desencadenante, ahorro mensual/anual hipotético, confianza, supuestos y advertencias. La evidencia de tendencia netea los reembolsos de la categoría contra los cargos del mismo mes, para no recomendar recortes por importes brutos que no representan el gasto neto. Cuando la señal es un exceso presupuestario, el porcentaje cuantifica ese exceso del último mes; el ahorro se calcula aplicándolo al gasto mensual medio del periodo. Por eso el ahorro hipotético no equivale necesariamente al exceso ni garantiza volver exactamente al presupuesto asignado. Los importes de ahorro son escenarios: no son ahorro observado ni garantizado. Los movimientos no convertidos se advierten.

## Simulación y guardado

El usuario puede seleccionar propuestas, editar el porcentaje de reducción y simular combinaciones. Cada categoría puede aparecer una sola vez por escenario para impedir el doble conteo. El motor rechaza categorías no marcadas como flexibles/revisables o con historial insuficiente.

Guardar un escenario conserva solo nombre, periodo, divisa, porcentajes y resultados de la simulación. Aceptar, rechazar o posponer una propuesta conserva una decisión local. Estas acciones son metadatos: no cambian movimientos, asignaciones, objetivos ni compromisos de Actual. La primera versión no aplica automáticamente cambios de presupuesto; por tanto, no ejecuta escrituras financieras ni necesita una previsualización de escritura.

## IA y privacidad

El diagnóstico, la generación básica de propuestas y las simulaciones funcionan sin Ollama. En esta primera entrega, las propuestas y sus importes son deterministas; no se envían movimientos, categorías ni informes a un modelo remoto. La narración conversacional opcional queda como mejora posterior, sujeta a los límites de contexto local ya existentes.

## Almacenamiento y recuperación

Las preferencias de categorías, objetivo, decisiones y escenarios se guardan localmente en `financial-actions.json`, mediante esquema versionado, validación estricta, permisos locales restrictivos, escritura atómica y bloqueo de modificaciones concurrentes. Este almacén está incluido en el backup cifrado unificado de Actual + Personal Budget. No conserva transacciones ni conversaciones.
