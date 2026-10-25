# Configuración

Los nombres de variables de `.env.example` son la propuesta inicial. Deben sincronizarse con el código y no considerarse una interfaz estable hasta que la implementación los valide.

| Variable | Propósito | Valor inicial propuesto |
|---|---|---|
| `APP_ENV` | Entorno de ejecución | `development` |
| `APP_HOST` | Interfaz de escucha | `127.0.0.1` |
| `APP_PORT` | Puerto de web local | `3000` |
| `LOG_LEVEL` | Nivel de log | `info` |
| `ACTUAL_SERVER_URL` | URL del servidor Actual | `http://127.0.0.1:5006` |
| `ACTUAL_BUDGET_ID` | Presupuesto de Actual seleccionado | Vacío hasta configurar |
| `ACTUAL_SERVER_PASSWORD` | Contraseña del servidor, si se configura | Vacío; no es contraseña bancaria |
| `ACTUAL_DATA_DIR` | Directorio de trabajo local del adaptador | `./.local/actual-api` |
| `OLLAMA_BASE_URL` | Endpoint de Ollama local | `http://127.0.0.1:11434` |
| `OLLAMA_MODEL` | Identificador del modelo instalado | Debe configurarse |
| `OLLAMA_REQUEST_TIMEOUT_SECONDS` | Límite de espera para generación | `120` |
| `AI_ENABLED` | Habilitar funciones de IA | `true` |
| `MCP_ENABLED` | Habilitar herramientas MCP | `true` |
| `AI_WRITE_OPERATIONS_ENABLED` | Permitir preparación de escrituras por IA | `false` |
| `CHAT_HISTORY_PERSISTENCE` | Persistencia del historial | `disabled` |
| `MAX_IMPORT_FILE_MB` | Límite de tamaño para importaciones | `25` |
| `MAX_CHAT_TOOL_CALLS` | Máximo de llamadas de herramientas por consulta | `8` |

## Reglas de configuración

- Guarda valores reales en `.env` y no lo añadas a Git.
- No añadas claves bancarias ni contraseñas de acceso al banco.
- Mantén los endpoints en loopback y bloquea el acceso desde otras interfaces.
- No configures URLs de proveedores de IA alojados si la política de privacidad requiere IA exclusivamente local.
- No habilites operaciones de escritura por IA durante la fase inicial.
- Las variables desconocidas deben generar un error o advertencia clara; no deben cambiar silenciosamente el comportamiento.
