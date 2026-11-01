# Configuración

La configuración de runtime se valida mediante Zod en services/api/src/config.ts. Mantén los valores reales en .env (excluido de Git); .env.example contiene únicamente defaults seguros.

## API local y Actual Budget

| Variable | Propósito | Default / límite |
|---|---|---|
| NODE_ENV | Entorno de Node | development, test o production |
| APP_HOST | Interfaz de escucha | 127.0.0.1; solo loopback |
| APP_PORT | Puerto de la API | 3000; 1024–65535 |
| LOG_LEVEL | Nivel de log | info |
| APP_ALLOWED_ORIGINS | Orígenes de navegador permitidos | Origins localhost exactos; no URLs con path |
| ACTUAL_SERVER_URL | Servidor Actual | http://127.0.0.1:5006; loopback |
| ACTUAL_SERVER_PASSWORD | Contraseña de la instancia Actual local | Vacío; no es contraseña bancaria |
| ACTUAL_BUDGET_ID | Sync ID del presupuesto seleccionado | Sin configurar hasta elegir |
| ACTUAL_DATA_DIR | Datos de trabajo locales del adaptador/estado propio | ./.local/actual-api |
| BUDGET_CURRENCY | Divisa base de configuración | EUR; código ISO de tres letras |

El directorio de datos del servidor Actual se configura también en Compose mediante ACTUAL_SERVER_DATA_DIR; debe coincidir con la ruta que el script de backup lee.

## Ollama e IA local

| Variable | Propósito | Default / límite |
|---|---|---|
| AI_ENABLED | Habilitar funciones de IA local | false |
| OLLAMA_BASE_URL | Endpoint de Ollama | http://127.0.0.1:11434; loopback |
| OLLAMA_MODEL | Modelo ya instalado | Vacío hasta configurar; 1–128 caracteres |
| OLLAMA_REQUEST_TIMEOUT_SECONDS | Timeout de inferencia | 120; 1–180 segundos |
| AI_MAX_CONTEXT_CHARS | Presupuesto de contexto | 4000; 512–8000 |
| AI_CATEGORY_CLASSIFICATION_ENABLED | Activar clasificación híbrida | false |
| AI_CATEGORY_CLASSIFICATION_INCLUDE_PAYEE | Permitir etiquetas normalizadas de beneficiario para clasificación local | true; no habilita la función por sí solo |

La URL remota de Ollama se rechaza. Desactivar AI_ENABLED no afecta a las funciones deterministas de finanzas.

## Búsqueda web externa controlada (#84)

La búsqueda requiere tanto AI_ENABLED=true como WEB_SEARCH_ENABLED=true, un modelo local con tool calling compatible y consentimiento por petición. Se mantiene desactivada por defecto.

| Variable | Propósito | Default / límite |
|---|---|---|
| WEB_SEARCH_ENABLED | Habilitar la búsqueda externa | false |
| WEB_SEARCH_BASE_URL | Origin del proveedor SearXNG | http://127.0.0.1:8080 local; remoto solo HTTPS |
| WEB_SEARCH_TIMEOUT_SECONDS | Timeout de proveedor | 8; 1–30 segundos |
| WEB_SEARCH_MAX_RESULTS | Máximo de resultados visibles | 5; 1–8 |
| WEB_SEARCH_MAX_QUERY_CHARS | Longitud máxima de consulta | 300; 20–500 |
| WEB_SEARCH_MAX_RESPONSE_KB | Máximo de JSON recibido | 128; 8–256 KiB |

Para una instancia autohospedada, configura SearXNG para servir JSON y limita el acceso a loopback o a la red privada del host. Para un proveedor alojado compatible, utiliza solo HTTPS y revisa su política de datos. SearXNG puede remitir la consulta a motores upstream; el hecho de autohospedarlo no significa que la consulta permanezca en esa máquina. Véase web-search.md.

## Seguridad de configuración

- No añadas claves bancarias, extractos ni credenciales en variables no documentadas.
- Mantén la API y Actual en loopback; no publiques puertos en LAN/Internet.
- No configures proveedores remotos de IA si la política exige inferencia local.
- La búsqueda externa es un permiso distinto de la IA: habilitar Ollama no habilita automáticamente la búsqueda.
- La herramienta no acepta direcciones, URLs ni dominios arbitrarios como destino; el proveedor es una configuración del operador.
- No habilites operaciones de escritura por IA.
- Las variables desconocidas o inválidas deben fallar claramente, no modificar el comportamiento de forma silenciosa.

Los valores de .env.example deben mantenerse sincronizados con el esquema de runtime y los tests de configuración.
