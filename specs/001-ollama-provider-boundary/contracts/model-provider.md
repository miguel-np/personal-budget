# Contract: ModelProvider

## Métodos

```ts
interface ModelProvider {
  readonly id: string;
  readonly capabilities: ModelProviderCapabilities;
  probe(model: string, signal: AbortSignal): Promise<ModelProviderAvailability>;
  chat(request: ModelProviderChatRequest, signal: AbortSignal): Promise<ModelProviderChatResponse>;
}
```

## Garantías

1. `probe` devuelve una de tres situaciones estables: disponible, modelo ausente o proveedor no disponible.
2. `chat` no ejecuta tool calls ni autoriza acciones; únicamente devuelve contenido y tool calls sin ejecutar.
3. Las peticiones reciben AbortSignal y el adaptador debe propagarlo al transporte.
4. Los errores de upstream no exponen cuerpos HTTP, URLs privadas, secretos ni mensajes de red.
5. El adaptador no persiste mensajes, prompts ni respuestas.
6. El adaptador no conoce cuentas, movimientos, categorías, presupuestos ni cálculos.
7. Las capacidades dependientes del modelo se declaran como tales; no se promete tool calling ni JSON estructurado universal.

## Contrato Ollama

- Probe: `GET /api/tags`.
- Chat: `POST /api/chat`, `stream: false`.
- El adaptador exige URL loopback sin usuario/contraseña embebidos.
- Mapea `models[].name` y `models[].model` a disponibilidad.
- Mapea `message.content` a `content` y `message.tool_calls` a `toolCalls`.
- Respuesta HTTP no satisfactoria, fallo de red o JSON inválido producen `ModelProviderUnavailableError`.
