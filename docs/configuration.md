# Configuración

La aplicación valida la configuración de runtime mediante Zod. Los valores privados se guardan en `.env`, que no debe añadirse a Git. Empieza con `.env.example` y modifica solo lo necesario.

## Configuración mínima para empezar

| Variable | Para qué sirve | Valor habitual |
|---|---|---|
| `APP_HOST` | Interfaz de red de la API | `127.0.0.1` |
| `APP_PORT` | Puerto de la API | `3000` |
| `APP_ALLOWED_ORIGINS` | Orígenes web autorizados | Origins localhost definidos en la plantilla |
| `ACTUAL_SERVER_URL` | Dirección del servidor Actual | `http://127.0.0.1:5006` |
| `ACTUAL_SERVER_PASSWORD` | Contraseña del servidor Actual, si configuraste una | Vacío por defecto |
| `ACTUAL_BUDGET_ID` | Sync ID del presupuesto elegido | Debes introducirlo |
| `ACTUAL_SERVER_DATA_DIR` | Volumen persistente de Actual en Compose | `./.local/actual-server-data` |
| `ACTUAL_DATA_DIR` | Directorio de datos propios/API | `./.local/actual-api` |
| `BUDGET_CURRENCY` | Divisa base de configuración | `EUR` |

No confundas `ACTUAL_SERVER_PASSWORD` con una contraseña bancaria. Personal Budget no necesita ni solicita tus credenciales bancarias.

## Runtime y diagnóstico

| Variable | Para qué sirve | Valor habitual |
|---|---|---|
| `NODE_ENV` | Entorno Node | `development` |
| `LOG_LEVEL` | Nivel de registro | `info` |
| `APP_HOST` | Host de escucha | `127.0.0.1` |
| `APP_PORT` | Puerto API | `3000` |
| `APP_ALLOWED_ORIGINS` | Lista exacta de orígenes permitidos | Localhost de la plantilla |

La API y la web deben permanecer en loopback salvo que exista un diseño de seguridad y despliegue distinto expresamente aprobado. No publiques los puertos en LAN o Internet.

## IA local opcional: Ollama

La IA está desactivada por defecto. Para activarla, instala Ollama, descarga un modelo compatible y configura:

| Variable | Para qué sirve | Valor inicial |
|---|---|---|
| `AI_ENABLED` | Habilita funciones de IA local | `false` |
| `OLLAMA_BASE_URL` | Endpoint de Ollama | `http://127.0.0.1:11434` |
| `OLLAMA_MODEL` | Nombre exacto del modelo instalado | Vacío hasta configurarlo |
| `OLLAMA_REQUEST_TIMEOUT_SECONDS` | Tiempo máximo de inferencia | `120` |
| `AI_MAX_CONTEXT_CHARS` | Límite de contexto | `4000` |
| `AI_CATEGORY_CLASSIFICATION_ENABLED` | Activa clasificación híbrida | `false` |
| `AI_CATEGORY_CLASSIFICATION_INCLUDE_PAYEE` | Permite etiquetas normalizadas de beneficiario para clasificación local | `true` |

La URL remota de Ollama se rechaza. La clasificación híbrida requiere tanto `AI_ENABLED=true` como `AI_CATEGORY_CLASSIFICATION_ENABLED=true`. Desactivar la IA no desactiva los cálculos financieros deterministas.

## Investigación web opcional: SearXNG

La búsqueda externa es un permiso independiente de la IA. Requiere IA habilitada, búsqueda habilitada, un modelo compatible con tool calling, proveedor SearXNG y consentimiento explícito para cada consulta.

| Variable | Para qué sirve | Valor inicial |
|---|---|---|
| `WEB_SEARCH_ENABLED` | Habilita el flujo de búsqueda | `false` |
| `WEB_SEARCH_BASE_URL` | Origin del proveedor | `http://127.0.0.1:8080` |
| `WEB_SEARCH_TIMEOUT_SECONDS` | Timeout | `8` |
| `WEB_SEARCH_MAX_RESULTS` | Máximo de resultados | `5` |
| `WEB_SEARCH_MAX_QUERY_CHARS` | Longitud máxima de consulta | `300` |
| `WEB_SEARCH_MAX_RESPONSE_KB` | Tamaño máximo de respuesta | `128` |

Los endpoints remotos requieren HTTPS. Una instancia SearXNG autohospedada puede reenviar consultas a motores upstream; revisa su configuración y privacidad antes de habilitarla. No se envían movimientos, cuentas ni agregados financieros a este flujo.

## MCP

MCP es opcional y se ejecuta por stdio; no abre un puerto TCP por defecto.

- `MCP_ENABLED`: interruptor de configuración, desactivado por defecto.
- `PERSONAL_BUDGET_API_URL`: URL de la API local cuando la configure el cliente MCP; solo se permiten hosts loopback.
- `PERSONAL_BUDGET_MCP_API_TIMEOUT_MS`: timeout de llamadas, con límites validados por el servidor.

Consulta [MCP](mcp.md) para configurar un cliente compatible y conocer el catálogo de herramientas.

## Variables operativas de backup

Los scripts de backup utilizan variables adicionales como `BACKUP_DIR`, `BACKUP_ENCRYPTION_KEY_FILE` y `BACKUP_RETENTION_DAYS`. Las rutas relativas se resuelven desde la raíz del repositorio. Consulta [Backup y restauración](backup-restore.md) antes de cambiarlas.

## Seguridad de configuración

- Mantén `.env` fuera de Git y no lo compartas.
- Mantén los servicios en loopback.
- No configures proveedores remotos de IA si necesitas inferencia local.
- Habilitar Ollama no habilita automáticamente la búsqueda web.
- La búsqueda externa exige consentimiento por petición.
- No habilites operaciones de escritura por IA.
- No uses valores desconocidos ni copies configuraciones de Internet sin entender su efecto.

Los valores exactos y límites validados viven en `services/api/src/config.ts` y `.env.example`; esos archivos son la referencia al modificar el runtime.
