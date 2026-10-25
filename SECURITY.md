# Política de seguridad

## Estado

Este es un proyecto personal-first cuya implementación aún está pendiente. Esta política define los requisitos de diseño y operación; no certifica que una versión futura los cumpla automáticamente.

## Informar una vulnerabilidad

No publiques detalles explotables, extractos financieros, archivos de presupuesto ni credenciales en issues públicos. Utiliza la función de comunicación privada de vulnerabilidades de GitHub si está habilitada en el repositorio. En un repositorio privado, informa al propietario por un canal privado acordado.

## Requisitos de seguridad

- Mantener la aplicación accesible solo desde `localhost` por defecto.
- No publicar los puertos de Actual Budget, Ollama, backend o MCP en interfaces de red externas.
- No exponer una herramienta para ejecutar shell, SQL arbitrario, código o rutas de archivo controladas por el modelo.
- Utilizar una lista permitida explícita de herramientas MCP.
- Validar y limitar entradas, fechas, importes, tamaño de archivos, número de resultados y duración de peticiones.
- Tratar CSV, OFX, QIF, QFX y CAMT como datos no confiables; validar estructura, codificación, tamaño y campos antes de procesarlos.
- Mantener secretos en archivos locales excluidos de Git. No incluir contraseñas bancarias.
- Enmascarar secretos en logs y errores. Evitar registrar descripciones y contenido íntegro de transacciones.
- Mantener dependencias actualizadas y ejecutar análisis de vulnerabilidades antes de publicar versiones.
- Respaldar los datos y probar la restauración. Las copias contienen información financiera sensible.

## Modelo de amenazas mínimo

Las amenazas incluyen acceso desde otro dispositivo en la red, malware local, extensión de navegador maliciosa, dependencia comprometida, prompt injection contenido en descripciones de movimientos, acceso excesivo del modelo a herramientas, pérdida o robo de las copias y errores de importación duplicando movimientos.

El carácter local no protege frente a alguien que ya tenga acceso a la cuenta de Windows/WSL o a los archivos sin cifrar. Utiliza cifrado de disco, una cuenta del sistema protegida y copias cifradas.
