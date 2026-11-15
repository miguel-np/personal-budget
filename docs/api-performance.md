# Rendimiento transversal del API

Este documento define una línea base reproducible para recorridos del API local distintos de la paginación de movimientos ya cubierta por la issue #28. El benchmark es opt-in, usa un API Fastify compilado y un contrato de Actual completamente sintético en memoria. No conecta con un servidor Actual, Ollama, SearXNG ni servicios externos.

## Ejecutar el benchmark

Desde la raíz del repositorio, con Node.js y npm de las versiones fijadas:

**npm run benchmark:api**

El comando compila finance-core, el adaptador y el API; después inicia un servidor Fastify temporal ligado exclusivamente a 127.0.0.1. Crea un presupuesto sintético en memoria, un directorio temporal privado, un objetivo y compromiso ficticios y un PDF mínimo generado para la prueba. El adaptador oficial de Personal Budget se utiliza con una implementación sintética de ActualApiContract; sus operaciones siguen pasando por la cola serializada real, pero no se ejecuta el SDK ni se abre ninguna conexión a Actual.

El informe se escribe en .local/benchmarks/api-load-<timestamp>.json, directorio excluido de Git. La salida de consola resume percentiles y errores, pero no imprime ni guarda cuerpos de respuesta, movimientos, beneficiarios, prompts o importes. El servidor y los datos temporales se cierran y eliminan al terminar.

## Escenarios

- **Dashboard overview:** lecturas paralelas de cuentas, categorías, preferencias, resumen y presupuesto mensual. Excluye deliberadamente GET /api/v1/transactions.
- **Reports comparison:** informes del mes actual y anterior solicitados en paralelo.
- **Monthly budget:** lectura de presupuesto y asignaciones de categorías.
- **Planning:** objetivos, compromisos, historial sintético de doce meses y agenda mensual.
- **Financial intelligence:** hallazgos deterministas sobre el periodo actual, historial de anomalías y recurrencias.
- **Local state and documents:** estado patrimonial, índice documental y descarga de un PDF sintético.

Cada escenario ejecuta clientes secuenciales con concurrencia 1, 5 y 10. Cada cliente procesa iteraciones en serie; cada recorrido puede contener varias rutas concurrentes. La ejecución completa repite por defecto cada combinación tres veces. La primera petición de cada escenario es una fase de calentamiento no incluida en las estadísticas.

## Métricas e interpretación

Para cada repetición se miden p50, p95 y p99 de la duración de un recorrido lógico, mínimo y máximo, operaciones por segundo, solicitudes HTTP por segundo, bytes de respuesta, distribución de códigos HTTP, errores de transporte y timeouts. Después de cada ráfaga se consulta /health y se registra su latencia y estado como comprobación de recuperación.

RSS y heap se muestrean cada 10 ms durante las mediciones. El informe conserva el máximo delta observado frente al inicio de cada repetición y el delta retenido al final. Es una aproximación de memoria del proceso completo: puede omitir asignaciones transitorias entre muestras y no representa el heap interno de un servidor externo.

El informe registra versión de Node, plataforma, arquitectura, número de CPU lógicas, cardinalidad sintética, repeticiones y nivel de concurrencia. No incluye hostname, rutas personales, configuración local, secretos ni datos de las respuestas.

No hay umbrales de latencia o memoria en la ejecución inicial. Una medición de runner no constituye por sí sola un objetivo de producto. Para proponer límites deben compararse varias ejecuciones en el mismo tipo de hardware/runner, separando variación normal y regresiones reproducibles. Los resultados del contrato sintético no se deben presentar como latencia del servidor Actual: sí permiten observar el coste del API, los cálculos, el mapeo y la cola del adaptador bajo una carga reproducible.

## Controles de ejecución

Variables opcionales:

- **API_LOAD_REPEATS:** repeticiones por combinación; valor predeterminado 3, rango 1–10.
- **API_LOAD_ITERATIONS_PER_CLIENT:** recorridos por cliente y repetición; valor predeterminado 5, rango 1–100.
- **API_LOAD_TRANSACTIONS_PER_ACCOUNT:** filas sintéticas generadas por cuenta; valor predeterminado 1.200, rango 20–20.000.

La CI ejecuta únicamente **node scripts/api-load-benchmark.mjs --smoke** después del build. El modo smoke mantiene los escenarios y los niveles de concurrencia 1/5/10, pero reduce el dataset a 40 movimientos por cuenta, una repetición y una iteración por cliente. Comprueba que el harness y los contratos funcionan; no impone presupuestos de rendimiento y no sustituye al benchmark completo.

Las pruebas de integración verifican por separado que /health responde mientras una lectura sintética sigue pendiente después de que el cliente cancele su conexión, que un error de proveedor se sanea y no envenena peticiones posteriores, y que el runtime procesa una ráfaga de lecturas. Las pruebas del adaptador cubren serialización de operaciones y recuperación de su cola tras un fallo. El contrato BudgetRepository no acepta AbortSignal: cancelar el cliente no cancela automáticamente una operación ya enviada al proveedor, que puede terminar en segundo plano y liberar su turno de la cola. La prueba demuestra aislamiento del endpoint de salud, no cancelación del trabajo del proveedor. El adaptador serializa lecturas en una cola de promesas, pero no expone profundidad ni un límite explícito de admisión. El benchmark verifica el vaciado de ráfagas finitas de 1/5/10 clientes y registra latencia/memoria; no demuestra seguridad frente a carga sostenida ilimitada. Esa limitación debe resolverse mediante un diseño de backpressure separado si las mediciones muestran riesgo.

## Backup y recuperación

El flujo destructivo de aceptación de backup/restauración no se ejecuta desde el benchmark HTTP. La aceptación existente se ejecuta en CI contra el servidor Actual aislado y el inventario financiero sintético. Esa ruta registra por separado el tiempo de crear la copia, rechazar una clave incorrecta y restaurar/verificar ambos conjuntos de datos. Cada ejecución es una sola observación de aceptación, no una línea base estadística ni un umbral de rendimiento. No la ejecutes en un checkout que contenga el presupuesto personal: el procedimiento elimina y restaura volúmenes y almacenes temporales de Actual.

## Límites y exclusiones

- No se vuelve a medir el algoritmo de paginación de transacciones ni se reutilizan los límites de la issue #28.
- No hay acceso directo a SQLite, archivos internos o volúmenes de una instalación personal de Actual.
- No se añaden cachés financieras, persistencia paralela, escrituras dobles ni cambios de semántica.
- Ollama y la búsqueda web están desactivados; ninguna ruta de benchmark envía datos a servicios externos.
- La carga completa es opt-in; CI ejecuta solo el smoke de contratos.
- Los resultados son una línea base de laboratorio sintético, no una certificación de rendimiento, ausencia de fugas o capacidad de hardware de producción.
