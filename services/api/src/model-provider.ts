export type ModelProviderCapability = 'supported' | 'unsupported' | 'model-dependent';

export interface ModelProviderCapabilities {
  readonly structuredOutput: ModelProviderCapability;
  readonly toolCalling: ModelProviderCapability;
  readonly streaming: ModelProviderCapability;
}

export interface ModelProviderChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly tool_name?: string;
  readonly tool_calls?: readonly ModelProviderToolCall[];
}

export interface ModelProviderToolCall {
  readonly function?: {
    readonly name?: string;
    readonly arguments?: unknown;
  };
}

export interface ModelProviderChatRequest {
  readonly model: string;
  readonly messages: readonly ModelProviderChatMessage[];
  readonly options?: Readonly<Record<string, unknown>>;
  readonly format?: 'json' | Readonly<Record<string, unknown>>;
  readonly tools?: readonly Readonly<Record<string, unknown>>[];
  /** Optional response-body cap applied by the adapter before JSON parsing. */
  readonly maxResponseChars?: number;
}

export interface ModelProviderChatResponse {
  readonly content: string;
  readonly toolCalls: readonly ModelProviderToolCall[];
}

export type ModelProviderAvailability = 'available' | 'model_missing' | 'unavailable';

/**
 * Provider boundary for model inference. Implementations own vendor-specific
 * transport, payload mapping and response parsing; they never execute tools.
 */
export interface ModelProvider {
  readonly id: string;
  readonly capabilities: ModelProviderCapabilities;
  probe(model: string, signal: AbortSignal): Promise<ModelProviderAvailability>;
  chat(request: ModelProviderChatRequest, signal: AbortSignal): Promise<ModelProviderChatResponse>;
}

export class ModelProviderUnavailableError extends Error {
  public constructor() {
    super('The configured model provider is unavailable.');
    this.name = 'ModelProviderUnavailableError';
  }
}
