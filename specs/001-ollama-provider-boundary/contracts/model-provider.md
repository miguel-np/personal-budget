# Contract: ModelProvider

## Methods

```ts
interface ModelProvider {
  readonly id: string;
  readonly capabilities: ModelProviderCapabilities;
  probe(model: string, signal: AbortSignal): Promise<ModelProviderAvailability>;
  chat(request: ModelProviderChatRequest, signal: AbortSignal): Promise<ModelProviderChatResponse>;
}
```

## Normalized request

`ModelProviderChatRequest` describes intent, not a vendor wire payload:

- `model`: identifier configured by the server.
- `messages`: system/user content, assistant content with normalized `toolCalls`, or tool result with `toolName`.
- `contextWindowTokens`, `maxOutputTokens`, `temperature`: optional generation controls independent of provider option names.
- `format`: JSON mode or a structured output schema.
- `tools`: definitions with `name`, `description` and `parameters`, never executable callbacks.
- `maxResponseChars`: optional bound checked by the adapter before JSON parsing.

`ModelProviderChatResponse` contains text and normalized tool calls `{ name, arguments }`. It does not contain provider response envelopes.

## Guarantees

1. `probe` returns one stable state: available, model missing or unavailable.
2. `chat` never executes tool calls; it only returns content and untrusted calls as data.
3. Requests receive an AbortSignal and the adapter must propagate it to transport.
4. Errors from upstream do not expose HTTP bodies, private URLs, secrets or network messages.
5. The adapter does not persist messages, prompts or responses.
6. The adapter does not know about accounts, transactions, categories, budgets or calculations.
7. Capabilities that depend on model/runtime are labeled as such; structured output and tool calling are not promised universally.
8. Vendor option names, tool schema wrappers, message encodings and response envelope parsing remain inside the adapter.

## Ollama wire mapping

- Probe: `GET /api/tags`.
- Chat: `POST /api/chat`, always `stream: false`.
- `contextWindowTokens` maps to `options.num_ctx`; `maxOutputTokens` maps to `options.num_predict`; `temperature` maps to `options.temperature`.
- Normalized tools are wrapped in Ollama's `{ type: "function", function: ... }` envelope.
- Assistant tool calls map to Ollama `message.tool_calls`; tool results map to `tool_name`.
- The adapter requires a loopback URL without embedded credentials.
- `models[].name` and `models[].model` are normalized to availability.
- `message.content` and `message.tool_calls` are normalized to `content` and `toolCalls`.
- Non-success HTTP, network failure, malformed JSON, malformed tool calls or body limit violations produce `ModelProviderUnavailableError`.
