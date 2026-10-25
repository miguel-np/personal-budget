# MCP: herramientas locales y límites

MCP es una interfaz opcional para exponer al cliente de IA funciones financieras revisadas. La aplicación web puede llamar a las mismas funciones del backend directamente; MCP no es necesario para renderizar el dashboard.

## Herramientas previstas

Todas las herramientas de consulta deben ser de solo lectura en la versión inicial.

| Herramienta | Uso | Acceso inicial |
|---|---|---|
| `get_monthly_summary` | Ingresos, gastos, ahorro y tasa para un mes | Solo lectura |
| `get_spending_by_category` | Totales por categoría y periodo | Solo lectura |
| `compare_periods` | Comparar periodos equivalentes | Solo lectura |
| `get_yearly_overview` | Resumen de cada mes del año | Solo lectura |
| `get_recurring_transactions` | Identificar candidatos a pagos recurrentes | Solo lectura; indicar que son candidatos |
| `get_uncategorized_transactions` | Movimientos pendientes de categoría | Solo lectura |
| `forecast_savings` | Escenario basado en reglas de cálculo explícitas | Solo lectura/cálculo |
| `simulate_budget_change` | Simular un ajuste sin guardar cambios | Solo lectura/cálculo |
| `prepare_transaction` | Preparar un movimiento para revisión | No escribe en Actual |
| `create_transaction` | Crear movimiento | Deshabilitada por defecto; requerir aprobación fuera del modelo |

## Política de herramientas

- No aceptar SQL libre, comandos shell, rutas de archivos arbitrarias ni URLs arbitrarias como argumentos controlados por el modelo.
- No dejar que el modelo elija un identificador de presupuesto/usuario sin validación de backend.
- Validar periodos, divisas, categorías, límites de resultados y tamaño de argumentos.
- Limitar el número de llamadas, duración total y tamaño de respuesta.
- Redactar salidas para devolver únicamente los campos necesarios.
- Mantener escrituras deshabilitadas hasta que haya confirmación explícita y pruebas de rollback/errores.
- Ejecutar MCP por `stdio` en la configuración local inicial. No exponerlo a la LAN/Internet sin autenticación, autorización y protección de transporte.

## Prompt injection y datos de transacciones

Las descripciones importadas pueden contener texto que parezca instrucciones. Deben tratarse como datos, no como instrucciones del sistema. La lógica de permisos pertenece al código, no al prompt. El modelo no puede ampliar su lista de herramientas ni anular permisos.

## Pruebas necesarias

Pruebas de esquema, argumentos inválidos, herramientas desconocidas, timeout, modelo sin tool calling, múltiples llamadas, datos ambiguos y solicitudes de escritura sin aprobación. La prueba de integración puede usar un presupuesto sintético y debe poder ejecutarse sin Internet.
