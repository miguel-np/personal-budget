# Ámbito global de cuentas

Personal Budget analiza un único presupuesto de Actual Budget, que puede contener varias cuentas. El ámbito de cuentas es una preferencia local para decidir qué cuentas participan en análisis; no crea usuarios, no añade permisos multiusuario y no cambia el contenido de Actual.

## Modos

- **Todas las cuentas abiertas** es el valor predeterminado y conserva los totales agregados anteriores.
- **Cuentas seleccionadas** incluye únicamente las cuentas abiertas guardadas en la preferencia. Una selección vacía significa literalmente cero cuentas, nunca equivale a «todas».
- En Movimientos se puede escoger además una cuenta concreta como filtro local. El backend comprueba que la cuenta esté dentro del ámbito global y rechaza una petición que lo ampliaría.

La preferencia se guarda en account-scope-preferences.json bajo ACTUAL_DATA_DIR (por defecto .local/actual-api) mediante reemplazo atómico y permisos restrictivos donde el sistema los soporta. La API revalida los IDs cada vez que resuelve el ámbito. Si una cuenta seleccionada se cierra o desaparece del presupuesto, las consultas fallan con un error accionable y Configuración sigue disponible para reparar o restablecer la selección; no se amplía silenciosamente el ámbito.

## Superficies afectadas

El mismo ámbito se aplica a resumen, tendencias e informes (incluidas comparativas), chat del asistente, Movimientos, detección de recurrentes, sugerencias de categoría y previsiones. Las herramientas del asistente reciben solamente el resumen/agregados calculados a partir del ámbito resuelto.

La API devuelve metadatos del ámbito activo junto con los resultados para que la interfaz pueda explicar a qué cuentas corresponden. La capa de resolución es común y valida que cualquier filtro local pertenezca al presupuesto actual y al ámbito guardado.

## Transferencias y movimientos divididos

Las transferencias internas siguen excluidas de ingresos y gastos consolidados, incluidas transferencias donde solo una de las cuentas está seleccionada. No se convierten en gasto ni ingreso por el mero hecho de excluir una de las patas. Los movimientos divididos se normalizan por sus submovimientos; la transacción padre no se suma de nuevo. El filtro de ámbito no modifica ni mueve transacciones en Actual.

## Presupuestos por categoría

Los presupuestos y las asignaciones nativas de Actual son del presupuesto completo, no se reparten automáticamente entre cuentas. Por ello, la sección Presupuestos mantiene su alcance global y lo explica explícitamente. Un gasto de solo algunas cuentas no debe presentarse como si tuviera una asignación presupuestaria independiente por cuenta.

## Pruebas

Los tests usan cuentas y movimientos sintéticos para verificar el valor inicial «todas», una o varias cuentas, selección vacía, cuentas cerradas/inexistentes, filtro local que intenta ampliar el ámbito, y propagación de la selección al asistente, recurrentes, sugerencias y previsiones. No necesitan presupuesto real, credenciales ni sincronización externa.
