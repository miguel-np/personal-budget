# ADR-0003: herramientas MCP con permisos limitados

- **Estado:** Aceptada para la especificación inicial.
- **Contexto:** El lenguaje natural facilita preguntas, pero no debe recibir acceso ilimitado a datos ni operaciones del sistema.
- **Decisión:** Exponer funciones financieras pequeñas, validadas y con esquema. Las consultas son de solo lectura; cualquier futura escritura requiere previsualización y aprobación explícita. MCP se ejecuta mediante stdio local inicialmente.
- **Consecuencias positivas:** Reduce el alcance de errores del modelo y permite probar de forma aislada cada operación.
- **Costes y limitaciones:** Se necesita mantener sincronizados los contratos de herramientas, el backend y las pruebas.
- **No permitido:** SQL arbitrario, shell, ejecución de código, acceso irrestricto a ficheros o solicitudes de red determinadas libremente por el modelo.
