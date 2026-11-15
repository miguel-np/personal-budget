export type ModelProviderCapability = 'supported' | 'unsupported' | 'model-dependent';

export interface ModelProviderCapabilities {
  readonly structuredOutput: ModelProviderCapability;
  readonly toolCalling: ModelProviderCapability;
  readonly streaming: ModelProviderCapability;
}

export interface ModelProviderToolCall {
  readonly name: string;
  readonly arguments: unknown;
}

export type ModelProviderChatMessage =
  | {
    readonly role: 'system' | 'user';
    readonly content: string;
  }
  | {
    readonly role: 'assistant';
    readonly content: string;
    readonly toolCalls?: readonly ModelProviderToolCall[];
  }
  | {
    readonly role: 'tool';
    readonly content: string;
    readonly toolName: string;
  };

export interface ModelProviderToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ModelProviderChatRequest {
  readonly model: string;
  readonly messages: readonly ModelProviderChatMessage[];
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly format?: 'json' | Readonly<Record<string, unknown>>;
  readonly tools?: readonly ModelProviderToolDefinition[];
  /** Optional response-body cap applied by the adapter before JSON parsing. */
  readonly maxResponseChars?: number;
}

export interface ModelProviderChatResponse {
  readonly content: string;
  readonly toolCalls: readonly ModelProviderToolCall[];
}

export type ModelProviderAvailability = 'available' | 'model_missing' | 'unavailable';

/**
 * Provider-neutral inference contract. Vendor-specific request options,
 * message serialization and tool schemas belong inside each adapter.
 * Tool calls are returned as data; providers never execute them.
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
