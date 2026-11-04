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
- `messages`: mensajes de sistema, usuario, asistente o resultado de herramienta.
- `options`: opciones propias del runtime que el adaptador interpreta.
- `format`: formato JSON o esquema estructurado.
- `tools`: definiciones declarativas; no son funciones ejecutables desde el proveedor.

## ModelProviderChatResponse

- `content`: texto producido por el modelo.
- `toolCalls`: tool calls solicitadas por el modelo, como datos no confiables que debe validar el backend.

## Persistencia

Ninguno de estos contratos se almacena en Actual Budget, JSON local, preferencias, backups ni exportaciones.
