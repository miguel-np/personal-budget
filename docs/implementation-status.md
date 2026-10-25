# Estado de implementación

**Base P0/P1:** stack de Actual, adaptador oficial, API y shell financiera están implementados. La última CI de main está verde. El cierre de P2 requiere CI verde en la rama y pruebas live explícitas; la instalación manual en WSL2 requiere un entorno de aceptación real.

| Área | Estado comprobable | Qué falta para cierre definitivo |
|---|---|---|
| Actual Compose | Imagen fijada, volumen persistente y puerto loopback; smoke test de CI | Verificar persistencia tras recreate desde Windows + WSL2 |
| Adaptador oficial | Implementado sobre @actual-app/api, operaciones serializadas y tests simulados; aceptación live opt-in | Ejecutar aceptación contra un presupuesto sintético real |
| Shell financiera | Dashboard, movimientos, importación CSV, presupuestos e informes | Prueba manual Windows + WSL2 e importación de prueba |
| Backup/restore | Scripts CLI, parada del contenedor, archivo fechado, checksum, retención y restore con copia previa | Ejecutar restore contra instancia aislada de Actual y comparar cuentas/categorías/movimientos |
| Ollama/chat | Opt-in, endpoint loopback, status, timeout, contexto agregado y UI; cifras calculadas por backend | Prueba live opt-in con un modelo local soportado |
| MCP | JSON-RPC sobre stdio, allowlist solo lectura, argumentos estrictos, límites y tests sintéticos | Validar con un cliente MCP concreto |
| Seguridad y CI | Lint, typecheck, build, pruebas, auditoría de dependencias y escaneo de secretos en workflow | Los escaneos no prueban ausencia de vulnerabilidades |
| Windows + WSL2 | CI Windows nativa y smoke test de Actual Linux | La prueba manual en distribución WSL2 no puede inferirse de esos jobs |

No cerrar las issues de aceptación manual por tener un workflow verde. No usar extractos ni presupuestos reales como fixtures de CI.
