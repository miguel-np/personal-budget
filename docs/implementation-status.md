# Estado de implementación

**Estado general: documentación y diseño inicial; implementación pendiente.**

Este archivo evita confundir el comportamiento deseado con el comportamiento comprobado. Debe actualizarse a medida que se implementen y prueben componentes.

| Área | Estado en este paquete | Criterio para considerarla completada |
|---|---|---|
| Documentación del proyecto | Disponible | Enlaces revisados y alineados con el código final |
| Actual Budget como gestor de cuentas y movimientos | Arquitectura definida | Instalación y prueba manual de la versión elegida |
| Adaptador `@actual-app/api` | Pendiente | Consultas de solo lectura probadas y gestión de errores validada |
| Interfaz web unificada | Pendiente | Vistas de dashboard, movimientos, informes y chat implementadas |
| Backend de aplicación | Pendiente | API local con validación, límites y pruebas |
| Importación en Actual Budget | Flujo documentado | Importar ficheros de prueba, revisar duplicados y conciliar saldos |
| Ollama | Integración prevista | Consulta local confirmada; endpoint sin acceso público |
| Herramientas MCP | Contrato propuesto | Pruebas de esquema, permisos, timeouts y llamadas reales |
| Análisis diario/mensual/anual | Reglas definidas | Casos de prueba para fechas, traspasos, devoluciones y distintas divisas |
| Copias de seguridad | Procedimiento definido | Restauración real probada con un presupuesto de prueba |
| Seguridad y privacidad | Requisitos documentados | Revisión de red, logs, dependencias, filesystem y tráfico saliente |
| Licencia | MIT aplicada en el repositorio | Confirmar que el titular acepta el uso comercial y los derivados con licencia distinta |

## Criterio de documentación

No marcar una capacidad como implementada porque exista una guía o un ejemplo de configuración. Debe existir el código, una prueba apropiada y una instrucción de uso validada.
