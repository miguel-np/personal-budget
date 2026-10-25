# ADR-0001: arquitectura local-first

- **Estado:** Aceptada para la especificación inicial.
- **Contexto:** Los datos gestionados son transacciones y hábitos financieros personales, que el usuario no quiere compartir con proveedores externos.
- **Decisión:** Ejecutar interfaz, backend, datos y modelo en el equipo local; desactivar telemetría y servicios de IA externos por defecto; escuchar en localhost; importar extractos bancarios manualmente.
- **Consecuencias positivas:** Menor exposición a proveedores externos, sin coste por token de IA, control sobre archivos y copias.
- **Costes y limitaciones:** El usuario mantiene software y copias, el rendimiento depende del hardware y no se ofrece sincronización móvil/entre dispositivos automáticamente.
- **Nota:** La ejecución local no protege frente a malware, otros usuarios del equipo ni configuraciones de red inseguras.
