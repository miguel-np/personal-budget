# IA local con Ollama

La integración de Ollama es opcional y utiliza la API del runtime en loopback. Está desactivada por defecto. Configura en .env: AI_ENABLED=true, OLLAMA_MODEL con el nombre de un modelo instalado, OLLAMA_BASE_URL=http://127.0.0.1:11434, OLLAMA_REQUEST_TIMEOUT_SECONDS=120 y AI_MAX_CONTEXT_CHARS=4000.

La configuración rechaza endpoints remotos de Ollama. El modelo debe estar instalado antes de utilizar el asistente.

## Frontera interna de proveedor

La API separa la orquestación de casos de uso de los detalles del runtime:

- `services/api/src/model-provider.ts` define el contrato neutral de proveedor, capacidades, probe por modelo, mensajes y respuesta normalizada.
- `services/api/src/ollama-provider.ts` encapsula `/api/tags`, `/api/chat`, el formato de opciones y el mapeo de tool calls de Ollama.
- `LocalAiClient` conserva prompts, límites de contexto, timeout, cancelación, cola, coalescing, métricas, sanitización y reglas de uso.
- El adaptador devuelve tool calls como datos no confiables. No ejecuta herramientas ni recibe acceso a SearXNG, Actual, SQL, shell o filesystem.
- Ollama es la única implementación conectada por defecto. OpenAI/xAI, selector, credenciales y enrutamiento siguen fuera de este incremento.

La frontera no cambia la configuración ni los endpoints públicos actuales.

## Asistente financiero

- Estado disponible en GET /api/v1/assistant/status.
- El chat valida pregunta, periodo y ámbito antes de consultar Actual.
- El backend calcula los agregados con finance-core y envía a Ollama un contexto compacto; no incluye descripciones, notas ni filas de movimientos.
- Las cifras se presentan desde el backend. La respuesta del modelo es cualitativa.
- El chat financiero no tiene tools, no navega, no puede leer ficheros/APIs, no dispone de permisos de escritura ni modifica Actual.
- Prompts y respuestas no se registran. Timeout, modelo ausente o runtime caído no bloquean el resto de la aplicación.

## Clasificación híbrida

La clasificación opcional requiere AI_ENABLED=true, AI_CATEGORY_CLASSIFICATION_ENABLED=true y OLLAMA_MODEL con un modelo local instalado.

La capa determinista actúa primero. Solo los casos sin evidencia suficiente pasan a la capa local; se envían referencias efímeras, catálogo de categorías permitido y, si se habilita, etiquetas normalizadas de beneficiarios. No se envían IDs reales de movimiento, cuentas, importes, fechas, notas ni filas históricas. Una salida inválida o incierta produce abstención y revisión manual.

AI_CATEGORY_CLASSIFICATION_INCLUDE_PAYEE=false evita enviar etiquetas normalizadas al modelo y desactiva esa clasificación por IA.

## Planificador conversacional

El planificador extrae intención a partir del texto escrito por la persona y un catálogo reducido de objetivos activos compatibles. No envía movimientos, cuentas, importes históricos ni saldos. El modelo no calcula proyecciones ni escribe objetivos/compromisos. El endpoint de previsualización siempre devuelve saved:false; los cambios persistentes se realizan en el flujo separado de Objetivos.

## Búsqueda web controlada (#84)

La investigación web es un segundo flujo independiente y no cambia el permiso del chat financiero. Requiere configurar WEB_SEARCH_ENABLED=true, un proveedor SearXNG y consentimiento explícito para cada consulta.

- El usuario escribe la consulta en el panel dedicado y confirma que autoriza su envío al proveedor externo.
- El backend envía a Ollama la consulta exacta y define una única tool allowlist llamada web_search.
- El modelo debe pedir exactamente esa búsqueda; la API rechaza una llamada ausente, adicional o con argumentos que modifiquen la consulta.
- El backend ejecuta SearXNG y devuelve un conjunto acotado de fuentes. La segunda inferencia usa los fragmentos como datos externos no confiables y no recibe tools.
- No se consulta el repositorio financiero ni se envía contexto financiero a Ollama en este flujo.
- La UI muestra proveedor, fecha de búsqueda, clase/dominio de fuente, enlaces originales y estado de recuperación documental. La segunda iteración recupera hasta tres documentos oficiales HTML/texto y, para normas BOE-A, metadatos/relaciones de la API de legislación consolidada; los extractos acotados se incorporan a la síntesis sin herramientas. DGT y TEAC se clasifican como tipos de criterio distintos de la norma publicada. Las limitaciones temporales BOE se muestran al usuario y no se presentan como validación jurídica. No se guarda historial de navegación ni se persisten documentos.
- El modo fiscal exige jurisdicción, materia, ejercicio fiscal, año de presentación y fecha de referencia explícitos. No se deducen desde movimientos ni ubicación del dispositivo.
- Los dominios oficiales admitidos incluyen AEAT, BOE, Hacienda, Seguridad Social, Xunta/DOG, CNMV y Banco de España. Un filtro de dominio restringe resultados, pero no certifica su vigencia o jerarquía jurídica.

La compatibilidad depende del soporte de tool calling estructurado del modelo/runtime. La validación live registrada para qwen3:8b se refiere al entorno probado; no garantiza otros modelos. Ante incompatibilidad se devuelve WEB_SEARCH_TOOL_UNSUPPORTED y no se ejecuta la búsqueda.

Consulta la guía de búsqueda web (web-search.md) para los límites, configuración del proveedor y lectura de resultados.

## Configuración, validación y límites

Las variables AI_ENABLED, OLLAMA_BASE_URL, OLLAMA_MODEL, OLLAMA_REQUEST_TIMEOUT_SECONDS y AI_MAX_CONTEXT_CHARS controlan la inferencia local. Las variables WEB_SEARCH_* configuran por separado el proveedor y sus límites.

La CI utiliza respuestas sintéticas y no requiere descargar Ollama ni realizar búsquedas reales. Las pruebas live deben usar prompts sintéticos, un modelo instalado y fuentes no sensibles.

La IA no constituye asesoramiento financiero, fiscal, jurídico ni profesional. Verifica los documentos originales y consulta a un profesional cuando dependa de circunstancias personales o de la vigencia normativa.
