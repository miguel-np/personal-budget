# Data Model: frontera de proveedor de IA

Este incremento no introduce persistencia ni modifica modelos financieros. Los tipos siguientes son contratos en memoria que existen durante una petición.

## ModelProvider

Identifica un adaptador y declara capacidades:
- `id`: identificador estable del adaptador (`ollama` en esta entrega).
- `capabilities.structuredOutput`: soportado, no soportado o dependiente de modelo/runtime.
- `capabilities.toolCalling`: soportado, no soportado o dependiente de modelo/runtime.
- `capabilities.streaming`: soportado, no soportado o dependiente de modelo/runtime.

## Probe

Entrada: identificador de modelo y AbortSignal.

Salida: `available`, `model_missing` o `unavailable`.

No devuelve endpoints internos, modelos no solicitados ni detalles de red.

## ModelProviderChatRequest

- `model`: nombre del modelo elegido por configuración backend.
- `messages`: mensajes normalizados de sistema/usuario, asistente con tool calls normalizadas o resultado de herramienta con su nombre.
- `contextWindowTokens`, `maxOutputTokens` y `temperature`: controles de generación independientes de los nombres de opción de cada proveedor.
- `format`: modo JSON o esquema estructurado.
- `tools`: definiciones con nombre, descripción y parámetros; nunca callbacks ejecutables.
- `maxResponseChars`: límite opcional del cuerpo de respuesta comprobado por el adaptador antes de parsear.

## ModelProviderChatResponse

- `content`: texto producido por el modelo.
- `toolCalls`: llamadas normalizadas como `{ name, arguments }`, no envueltas en el sobre de ningún proveedor.

## Persistencia

Ninguno de estos contratos se almacena en Actual Budget, JSON local, preferencias, backups ni exportaciones.
