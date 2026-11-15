# ADR-0004: dependencia de Actual Budget y evolución del proveedor financiero

- **Estado:** Aceptada.
- **Fecha:** 15 de noviembre de 2026.
- **Decisión:** Mantener Actual Budget como única fuente de verdad financiera. Continuar optimizando el uso de su API oficial y conservar los contratos neutrales de `finance-core`; no introducir un segundo almacén financiero ni sustituir el proveedor en producción.
- **Ámbito:** Arquitectura y evolución del proveedor. Esta decisión no autoriza cambios de código, despliegues ni migraciones.

## Contexto

Personal Budget utiliza Actual Budget para cuentas, categorías, presupuestos y movimientos. El SDK oficial `@actual-app/api` es la frontera de integración en `services/actual-adapter`. El resto del backend consume contratos de dominio neutrales en `packages/finance-core`.

Esta arquitectura evita reimplementar un libro financiero completo y reduce el riesgo de mantener dos representaciones mutables de los mismos movimientos. La independencia contractual no equivale, sin embargo, a independencia operativa: el ciclo de vida, la fuente de verdad, el backup/restauración y parte de la semántica siguen ligados a Actual.

Las dependencias que motivaron esta decisión ya aportan evidencia:

- **#28 — rendimiento e historiales:** benchmark sintético de 10.000, 50.000 y 100.000 filas, además de un mes denso y cuatro cuentas. En CI con Node 24.22.1 se registraron medianas de 33,5 / 93,8 / 193,1 ms para los tamaños repartidos en doce meses; 299,3 ms para 100.000 filas en un mes; y 336,7 ms para 100.000 filas en cuatro cuentas. El heap máximo muestreado fue de 3,0 / 12,3 / 15,8 MB, 15,7 MB y 16,0 MB respectivamente. Son mediciones de fixtures sintéticos y del proceso observado, no mediciones del tiempo o memoria internos del servidor/SDK ni garantías para datos reales. El muestreo de heap cada 1 ms aproxima el máximo observable y puede omitir asignaciones más breves.
- **#65 — contratos neutrales:** `BudgetRepository`, errores de dominio y suite de conformidad separan consumidores y proveedor. El contrato facilita evaluar otro adaptador, pero no resuelve la migración del libro de datos, las identidades, las relaciones ni la recuperación integral.
- **#64 — recuperación:** el backup unificado incluye el volumen persistente de Actual y los almacenes propios inventariados. Sustituir Actual afectaría a un procedimiento de recuperación ya integrado y probado; no sería un simple cambio de adaptador.

## Capacidades y límites confirmados de Actual

### API oficial

Actual no ofrece una API REST general para que Personal Budget consulte directamente endpoints HTTP. La integración soportada es el paquete Node.js `@actual-app/api`, que ejecuta el cliente en modo headless. No se debe confundir el servidor de sincronización con un backend REST de consultas financieras ni acceder directamente a SQLite o a ficheros internos.

La lectura `getTransactions(accountId, startDate, endDate)` devuelve todos los movimientos de la cuenta dentro del intervalo inclusivo. Su firma no acepta cursor, `limit` ni `offset`. Por tanto, la paginación REST de Personal Budget no es paginación nativa de esa operación: actualmente segmenta por meses y mantiene una selección acotada en el backend, con un presupuesto máximo de 100.000 filas presentadas por petición.

### ActualQL

Actual también ofrece ActualQL (`q` / `aqlQuery`) para filtrar, ordenar y seleccionar datos. La documentación de ActualQL explica expresamente los modos de splits `inline`, `grouped` y `all`; la interfaz elegida cambia qué filas aparecen y cómo se representan los padres e hijos. La referencia del CLI documenta además opciones `limit`, `offset` y `count` para consultas. Estas capacidades no deben atribuirse a la firma de `getTransactions`, ni asumirse como un cursor o una instantánea consistente.

La issue #28 verificó contra `@actual-app/api` 26.10.0 que la vía ActualQL permite empujar filtros, orden, selección y límites/offset al origen. No proporciona por sí sola cursor ni snapshot entre peticiones. El uso de offset sobre un conjunto mutable puede desplazar resultados; obtener un total exacto puede requerir una consulta adicional. La semántica de splits debe fijarse y probarse antes de sustituir el recorrido actual.

### Garantías y semántica relevantes

La API documenta movimientos divididos como un padre con subtransacciones; las subtransacciones son registros completos y la actualización fiable del split se realiza sobre el padre con el conjunto completo de subtransacciones. Las transferencias enlazan movimientos de dos cuentas mediante `transfer_id` y deben crearse usando los payees de transferencia.

La evaluación de #65 identifica además capacidades y límites relevantes:

- No hay garantía de cursor ni de snapshot para recorrer varias páginas.
- No existe una operación atómica genérica de actualización de categorías en lote.
- Las escrituras entre entidades no forman una transacción multi-entidad.
- La confirmación de una escritura debe esperar a que el estado nuevo sea observable cuando el contrato requiere verificación.
- Presupuestos por categoría, payees de transferencia, importación/reconciliación y splits deben mapearse con su semántica, no solo por similitud de nombres.

## Opciones consideradas

### A. Mantener Actual y optimizar la API oficial — elegida para la evolución inmediata

Usar `getTransactions` con intervalos acotados donde su semántica sea la adecuada y evaluar ActualQL en rutas concretas cuando los filtros o límites empujados al origen compensen el coste de mantener un segundo camino de consulta. Conservar pruebas de conformidad de splits, transferencias, orden, totales y consistencia.

**Ventajas:** conserva la fuente de verdad y el flujo de recuperación; evita un segundo motor y aprovecha funcionalidades ya mantenidas por Actual.

**Costes y límites:** las restricciones de cursor/snapshot permanecen; ActualQL tiene semántica propia de splits que exige pruebas y su documentación sigue siendo menos completa que la de una API paginada convencional.

### B. Mantener Actual y reforzar los contratos neutrales — ya implementada

La issue #65 completó esta separación: el núcleo define contratos y errores de dominio; el adaptador encapsula el SDK; la suite de conformidad permite contrastar proveedores.

**Ventajas:** reduce acoplamiento y permite experimentos de proveedor sin cambiar consumidores.

**Costes y límites:** el contrato no convierte automáticamente los datos, IDs, relaciones, sesiones ni backups de Actual a otro proveedor. Las capacidades opcionales deben seguir declarando honestamente lo que un proveedor soporta.

**Decisión:** mantener esta frontera como arquitectura estable. No crear abstracciones adicionales hasta que un segundo proveedor real demuestre una necesidad concreta.

### C. Prototipo de almacenamiento local propio (por ejemplo, SQLite)

Una prueba de concepto podría implementar el contrato `BudgetRepository` sobre una base local aislada, usando únicamente fixtures sintéticos. No se habilitaría como fuente de verdad ni se conectaría al presupuesto personal durante la evaluación.

**Ventajas potenciales:** control sobre índices, consultas, paginación, snapshots, transacciones y evolución del esquema.

**Costes reales:** habría que implementar y mantener integridad contable, splits, transferencias, presupuestos, importación/reconciliación, multimoneda, concurrencia, migraciones, backup/restore, recuperación, compatibilidad y herramientas operativas. También habría que auditar límites y fallos que hoy asume Actual. SQLite reduce la infraestructura de despliegue, pero no elimina el coste de construir y mantener un motor financiero correcto.

**Decisión:** no iniciar el prototipo todavía. La evidencia actual de #28 no muestra un cuello de botella que justifique duplicar esa superficie funcional.

### D. Evaluar Firefly III como proveedor alternativo

Firefly III es un gestor financiero autoalojado con API JSON, cuentas, transacciones, categorías, presupuestos, reglas y recurrencias. Su modelo y flujo de despliegue son propios; no implementa el contrato de Personal Budget de forma nativa.

Antes de considerarlo habría que demostrar con fixtures que cubre los casos necesarios de Personal Budget: transferencias enlazadas, splits y su edición, importación con conciliación/deduplicación, presupuestos por categoría, divisas, fechas, IDs estables, operaciones parciales y recuperación. La existencia de endpoints con nombres parecidos no acredita equivalencia semántica ni compatibilidad.

**Licencia:** el repositorio de Firefly III declara AGPL-3.0. Actual Budget declara MIT. La licencia del proyecto alternativo no cambia automáticamente la licencia de Personal Budget, pero incorporar o modificar código, redistribuir componentes o combinar obras puede tener consecuencias que requieren revisar los términos concretos. No se copiará código ni se redistribuirá el servicio como parte de esta evaluación.

**Costes:** operar Firefly III introduce otro servicio, su base de datos/configuración, actualizaciones y backups; sustituir Actual exigiría migración y validación de inventarios y relaciones. No se ha ejecutado una prueba de concepto ni una evaluación de paridad funcional; esas capacidades se consideran pendientes de verificación, no aprobadas.

**Decisión:** mantenerlo como candidato de investigación, no como reemplazo seleccionado.

## Comparación resumida

| Criterio | Actual optimizado | Contratos neutrales | SQLite propio | Firefly III |
|---|---|---|---|---|
| Fuente de verdad actual | Conservada | Conservada | Cambiaría en un prototipo activo | Cambiaría si se migra |
| Trabajo inmediato | Bajo/dirigido | Ya integrado | Alto | Alto |
| Control de consultas | Limitado por API; ActualQL amplía opciones | No lo cambia | Potencialmente alto, por demostrar | Depende de endpoints y modelo |
| Semántica financiera | Ya integrada y usada | Neutraliza tipos, no semántica | Hay que implementarla | Hay que mapearla y probarla |
| Atomicidad/snapshot | Límites documentados | No los añade | Diseñable, con coste | Debe verificarse por operación |
| Recuperación | Integrada con #64 | No migra datos | Nuevo diseño y pruebas | Nuevo despliegue y migración |
| Coste operativo | Servicio Actual existente | Coste marginal bajo | Mantenimiento de motor propio | Servicio y almacenamiento adicionales |
| Licencia del proveedor | MIT | No añade proveedor | SQLite: dominio público | AGPL-3.0 |
| Estado de evidencia | Benchmark y uso existentes | Suite de conformidad existente | Sin PoC | Sin PoC de paridad |

## Decisión

Mantener Actual Budget como única fuente de verdad y conservar el adaptador oficial como única frontera runtime del SDK. Mantener los contratos neutrales de #65 y la recuperación integrada de #64. Para rendimiento, elegir la operación oficial más apropiada por caso y evaluar ActualQL de forma localizada, sin afirmar que proporciona cursor o consistencia de snapshot.

No se adopta SQLite ni Firefly III. La independencia teórica no compensa reimplementar o mantener una segunda fuente de verdad sin una necesidad demostrada. La implementación actual ya tiene límites explícitos, benchmark sintético y un contrato desacoplado suficiente para aplazar esa inversión.

## Condiciones verificables para reconsiderar la decisión

Abrir una issue de investigación o una PoC aislada si se cumple al menos una de estas condiciones:

1. **Regresión de rendimiento reproducible:** el benchmark sintético versionado de #28 supera en tres ejecuciones consecutivas cualquiera de sus límites de regresión actuales (mediana de 3 s o heap adicional muestreado de 128 MiB), tras descartar regresiones del propio código de Personal Budget. Estos límites son alarmas de CI, no objetivos de rendimiento ni evidencia de que otro motor vaya a ser más rápido.
2. **Necesidad funcional no resoluble:** una capacidad requerida por una funcionalidad aprobada no puede implementarse correctamente con la API oficial soportada, y la limitación queda reproducida con una prueba mínima contra la versión fijada.
3. **Riesgo de consistencia o recuperación:** una prueba sintética demuestra que las garantías necesarias para una operación crítica no pueden obtenerse con el adaptador y los procedimientos de recuperación actuales.
4. **Ventaja comparativa demostrada:** una PoC separada, con el mismo contrato y fixtures, muestra una mejora material y repetible sin pérdida de semántica ni un coste de operación/mantenimiento desproporcionado.

Toda PoC deberá:
- usar datos sintéticos y un entorno desechable, sin acceso a SQLite de Actual ni a datos financieros personales;
- definir antes de medir los escenarios, métricas, límites y criterios de paridad;
- cubrir cuentas, categorías, transacciones, splits, transferencias, presupuestos, importación, multimoneda y recuperación;
- medir latencia, memoria, concurrencia, integridad y comportamiento ante fallos;
- validar exportación/importación e inventarios antes/después, con IDs y relaciones explícitos;
- incluir revisión de licencia, seguridad, privacidad, despliegue y coste de mantenimiento;
- permanecer fuera de producción y sin escrituras dobles.

Una propuesta de migración requerirá una decisión arquitectónica nueva, plan de reversión y aceptación explícita; este ADR no la autoriza.

## Consecuencias

- Actual sigue siendo la única fuente de verdad y no se introduce sincronización financiera entre motores.
- El adaptador oficial mantiene encapsulado el SDK y el resto de la API conserva contratos neutrales.
- Las mejoras de consulta deben conservar pruebas de splits, transferencias, orden, filtros y límites.
- Los benchmarks deben permanecer sintéticos y describir con precisión qué miden.
- La posible sustitución se tratará como proyecto de migración y recuperación, no como refactor del adaptador.

## Referencias

### Evidencia del repositorio

- [Issue #28 — paginación y rendimiento](https://github.com/miguel-np/personal-budget/issues/28) y [PR #63](https://github.com/miguel-np/personal-budget/pull/63): benchmark, límites, heap muestreado y consistencia entre páginas.
- [Issue #65 — contratos neutrales](https://github.com/miguel-np/personal-budget/issues/65) y [PR #96](https://github.com/miguel-np/personal-budget/pull/96): contrato `BudgetRepository` y suite de conformidad.
- [Issue #64 — backup y recuperación](https://github.com/miguel-np/personal-budget/issues/64) y [PR #89](https://github.com/miguel-np/personal-budget/pull/89).
- [Contratos financieros independientes del proveedor](../provider-contracts.md).
- [Rendimiento de historiales y ActualQL](../transactions-and-imports.md).

### Documentación oficial de terceros

- [Actual Budget — Using the API](https://actualbudget.org/docs/api/): SDK oficial y ausencia de API REST general.
- [Actual Budget — API Reference](https://actualbudget.org/docs/api/reference/): firma y semántica de `getTransactions`, splits y transferencias.
- [Actual Budget — ActualQL](https://actualbudget.org/docs/api/actual-ql/): filtros y modos de splits.
- [Actual Budget — CLI / ActualQL](https://actualbudget.org/docs/api/cli/): opciones documentadas de consulta `limit`, `offset` y `count`.
- [Actual Budget — repositorio y licencia](https://github.com/actualbudget/actual): MIT.
- [Firefly III — documentación de API](https://docs.firefly-iii.org/references/firefly-iii/api/).
- [Firefly III — repositorio y licencia](https://github.com/firefly-iii/firefly-iii): AGPL-3.0.

La documentación externa puede evolucionar. Antes de implementar una optimización o migración, comprobar la versión exacta fijada en el proyecto y repetir las pruebas de contrato correspondientes.
