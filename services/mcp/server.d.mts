import type { Interface as ReadlineInterface } from 'node:readline';

export type McpHandler = (message: unknown) => Promise<unknown>;

export interface McpStdioOptions {
 inputStream?: NodeJS.ReadableStream;
 outputStream?: NodeJS.WritableStream;
 errorStream?: NodeJS.WritableStream;
 handler?: McpHandler;
}

export declare function createMcpHandler(): McpHandler;
export declare function startMcpStdio(options?: McpStdioOptions): ReadlineInterface | null;
