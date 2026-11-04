# Research: frontera de proveedor Ollama

**Fecha**: 2026-11-04

## Hallazgos del código actual

1. `services/api/src/local-ai.ts` contenía acceso directo a `/api/tags` y `/api/chat`, además de serialización/parsing de payloads Ollama.
2. Los flujos que usan chat son explicación financiera, clasificación de categorías, extracción de intención de planificación e investigación web con una única llamada `web_search`.
3. La cola, cancelación, coalescing, caché de readiness, saneamiento narrativo y métricas ya viven en `LocalAiClient`; no son peculiaridades de Ollama.
4. `services/api/src/app.ts` crea el cliente en la raíz de composición y conserva la orquestación de cuentas, datos financieros, autorizaciones y ejecución de SearXNG.
5. El contexto del chat financiero se construye con agregados deterministas. La búsqueda externa recibe únicamente la consulta aprobada y el backend ejecuta SearXNG.

## Decisiones

### D1 — Contrato interno pequeño, no SDK universal

Se adopta `ModelProvider` con tres piezas: capacidades, probe por modelo y chat normalizado. No se añade streaming en este incremento porque el código actual utiliza respuestas no streaming. El contrato declara explícitamente streaming como no soportado por el adaptador actual.

### D2 — Ollama conserva su dialecto dentro del adaptador

Los endpoints, `stream: false`, forma de `options`, `format`, mensajes y respuesta `message.tool_calls` permanecen en `OllamaProvider`. `LocalAiClient` envía una solicitud neutral y recibe `content` + `toolCalls`.

### D3 — Capacidades declaradas sin fingir compatibilidad

La salida estructurada y tool calling se marcan como dependientes del modelo/runtime. Una respuesta sin la tool correcta sigue produciendo el error de incompatibilidad actual; el backend no simula que la búsqueda se ejecutó. La UI detallada de capacidades queda para una especificación posterior.

### D4 — Ningún proveedor ejecuta herramientas

El adaptador solo transporta y normaliza tool calls. La API valida el nombre, argumentos y consulta exacta aprobada; luego llama al proveedor SearXNG configurado. La segunda inferencia no recibe herramientas.

### D5 — Errores del proveedor saneados

Los errores HTTP, de red y de parseo se normalizan a `ModelProviderUnavailableError`. `LocalAiClient` los convierte en `LocalAiUnavailableError`, que es el contrato que las rutas ya conocen. No se incluye cuerpo upstream ni URL privada en los errores.

### D6 — Sin persistencia ni configuración nueva

El proveedor por defecto sigue siendo Ollama con las mismas variables `OLLAMA_*`. No se incorporan claves, perfiles o preferencias de proveedores porque OpenAI/xAI quedan fuera de alcance.

## Alternativas descartadas

- **SDK compartido de OpenAI para todos**: no representa fielmente diferencias de API ni requisitos de privacidad/consentimiento.
- **Abstracción en finance-core**: los modelos no forman parte del dominio financiero ni deben convertirse en dependencia del núcleo.
- **Mover todo el LocalAiClient al adaptador**: mezclaría prompts, serialización de datos financieros, coalescing y políticas de aplicación con el protocolo del proveedor.
- **Implementar OpenAI/xAI ahora**: ampliaría el riesgo de privacidad, credenciales y compatibilidad antes de validar la frontera con el proveedor local.
