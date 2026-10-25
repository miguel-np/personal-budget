# ADR-0002: Actual Budget como motor financiero

- **Estado:** Aceptada para la primera versión objetivo.
- **Contexto:** Crear un gestor financiero completo desde cero duplicaría cuentas, categorías, presupuestos, conciliación e importación.
- **Decisión:** Utilizar Actual Budget como fuente de verdad financiera y desarrollar una interfaz web personalizada encima. Acceder mediante el paquete oficial `@actual-app/api`; no asumir que existe una API REST general.
- **Consecuencias positivas:** Reutiliza funciones financieras existentes y reduce el alcance de lógica contable propia.
- **Costes y limitaciones:** La app depende de la API y los ciclos de sincronización compatibles con Actual. Debe probarse el adaptador con la versión concreta.
- **Alternativa descartada inicialmente:** Base de datos financiera propia en paralelo, por el riesgo de divergencia entre registros.
