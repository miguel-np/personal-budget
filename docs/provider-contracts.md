# Contratos financieros independientes del proveedor

Personal Budget usa Actual Budget como fuente de verdad financiera, con una frontera de acceso en `services/actual-adapter` y contratos de dominio en `packages/finance-core`. Este documento registra la auditoría de dependencias de la issue #65, las garantías del contrato `BudgetRepository` y las capacidades que hoy solo ofrece Actual, para que un futuro segundo adaptador pueda añadirse sin propagar tipos, conceptos o errores específicos del proveedor por el resto de la aplicación.

## Mapa de dependencias

| Consumidor | Depende de | ¿Toca el SDK o formas de Actual? | Justificación |
|---|---|---|---|
| `packages/finance-core` | nada externo | No | Dominio puro: tipos propios (`BudgetAccount`, `BudgetTransaction`, `LedgerEntry`…), unidades menores explícitas y errores de dominio (`BudgetRepositoryError`). |
| `apps/web` | `@personal-budget/finance-core` (vía API REST) | No | La interfaz consume únicamente respuestas JSON de la API local. |
| `services/api` | `@personal-budget/finance-core` | No | `app.ts` depende de `BudgetRepository`, de los contratos neutros (`ImportRecord`, `BudgetMonthRecord`…) y de `BudgetRepositoryError`. Los casts a formas específicas del adaptador fueron eliminados en #65. |
| `services/api/src/main.ts` | `@personal-budget/actual-adapter` | No | Raíz de composición: instancia el adaptador concreto con `createActualApiContract()`. Ya no importa `@actual-app/api`. |
| `services/actual-adapter` | `@actual-app/api`, `@personal-budget/finance-core` | Sí (único paquete permitido) | Aquí viven los registros crudos del SDK (`ActualAccountRecord`, `ActualCategoryRecord`…) y su mapeo a tipos de dominio (`mapActualAccount`, `mapActualCategory`), además de la consulta AQL de asignaciones presupuestarias (`create-actual-api-contract.ts`). |
| `scripts/*` (backup, aceptación, actualización) | `@actual-app/api` directamente | Sí (excepción documentada) | Herramientas operativas de aceptación y recuperación que actúan sobre el servidor Actual en sí; no forman parte del runtime de la aplicación. |
| `services/mcp` | API REST local | No | Solo lectura sobre los endpoints locales. |

Regla: **ningún módulo fuera de `services/actual-adapter` y de los scripts operativos puede importar `@actual-app/api`**. El mapeo de IDs, divisas, estados y errores específicos de Actual sucede en la frontera del adaptador.

## Contrato `BudgetRepository`

Véase la documentación del interfaz en `packages/finance-core/src/domain.ts`. Resumen:

- **Obligatorias:** `isConfigured`, `listAccounts`, `listCategories`, `listTransactions`.
- **Opcionales (solo si el proveedor las soporta de verdad):** `updateTransaction`, `updateTransactionSafely`, `updateTransactionCategoriesBatch`, `updateTransactionCategory`, `getBudgetMonth`, `getBudgetAllocations`, `setBudgetAmount`, `listTransferPayees`, `importTransactions`. Los consumidores las sondean con `typeof`; nunca deben simularse con datos falsos.
- **Semántica de errores:** toda falla distinguible se lanza como `BudgetRepositoryError` (`INVALID_INPUT`, `NOT_CONFIGURED`, `CLOSED`, `UPSTREAM_FAILURE`). Los errores nativos inesperados se envuelven como `UPSTREAM_FAILURE`; nunca se convierten en éxitos silenciosos. `ActualAdapterError` extiende la clase de dominio, de modo que la API sanea errores sin conocer el proveedor.
- **Garantías de persistencia:** las escrituras sincronizan con el proveedor; un resultado `verified: true` solo se emite después de que el nuevo estado es observable en una lectura posterior (`updateTransactionSafely`). El lote de categorías es no atómico: preflight completo, conflictos y fallos parciales explícitos en `TransactionCategoryBatchResult`, sin "compensaciones" silenciosas.
- **Ciclo de vida:** `init`/`close`/`shutdown` forman parte del contrato del adaptador concreto, no del límite de lectura/escritura. `main.ts` los invoca sobre el tipo concreto.

## Capacidades y limitaciones del proveedor actual

Capacidades que hoy **solo ofrece Actual Budget** y que un futuro proveedor debería cubrir para mantener paridad:

- Consulta mensual de presupuestos por categoría (`getBudgetMonth`) y asignaciones explícitas vía AQL (`zero_budgets`/`reflect_budgets`).
- Payees de transferencia para crear transferencias vinculadas (`listTransferPayees`).
- Importación de extractos con re-importación y normalización de beneficiario (`importTransactions`).
- Movimientos divididos anidados (`is_parent`/`subtransactions`) y transferencias con `transfer_id` cruzado.

Garantías que la API oficial de Actual **no proporciona** y que el adaptador no finge:

- **Paginación por cursor:** `getTransactions` no ofrece cursor, limit ni offset; la API local segmenta por meses naturales y acota el trabajo (véase #28).
- **Atomicidad de lotes:** no existe una actualización atómica de categorías en lote; de ahí el preflight y los resultados parciales explícitos.
- **Transacciones entre entidades:** cada escritura es una operación aislada; no hay unidades de trabajo multi-entidad.
- **Read-your-writes inmediato:** la API puede aplicar escrituras de forma asíncrona; `updateTransactionSafely` y el lote esperan a que el estado sea observable antes de confirmar.

## Suite de conformidad reutilizable

`packages/finance-core` exporta `runRepositoryConformance(runner, { repositoryName, createRepository })` junto con `conformanceFixture` (cuentas abiertas/cerradas, categorías, transferencias vinculadas, split con hijos, importes en unidades menores y fechas civiles). El runner es estructural (`describe`/`it`/`expect`), de modo que la suite funciona con vitest hoy y con cualquier framework futuro.

Se ejecuta en dos escenarios:

1. **Proveedor de referencia en memoria** (`packages/finance-core/tests/repository-conformance.test.ts`): documenta la semántica esperada del contrato sin dependencias.
2. **Adaptador real sobre un contrato SDK sintético** (`services/actual-adapter/tests/repository-conformance.test.ts`): demuestra que `ActualBudgetAdapter` satisface la frontera sin tocar el cliente oficial.

Cubre: importes en unidades menores, fechas civiles, moneda, transferencias, movimientos divididos, orden determinista, cuentas cerradas, fallos parciales, confirmación de persistencia, importación dry-run por defecto y rechazo de rangos inválidos con la taxonomía de errores de dominio.

## Alcance y límite de esta abstracción

Este contrato **facilita** una futura sustitución del proveedor, pero **no implica que cambiar de proveedor sea posible sin migración de datos**: la fuente de verdad, el ciclo de vida de sesiones y el backup/restauración integral (#64) siguen siendo específicos de Actual Budget. No introduce una segunda base financiera ni escrituras dobles.
