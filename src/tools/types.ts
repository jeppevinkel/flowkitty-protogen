import type Anthropic from '@anthropic-ai/sdk';

/**
 * Shared context injected into every tool handler at execution time.
 * Extend this as the tool surface grows — e.g. add `guildId`, `authorId`.
 */
export interface ToolContext {
    channelId: string;
}

/**
 * A client-side tool: the Anthropic spec the model sees, plus the handler we
 * run when the model invokes it.
 *
 * TInput is the shape of the validated `input` object the model sends.
 * Keeping it generic lets each tool file be precisely typed while the registry
 * holds a heterogeneous collection.
 */
export interface ToolDefinition<TInput = Record<string, unknown>> {
    spec: Anthropic.Tool;
    execute: (input: TInput, ctx: ToolContext) => Promise<string>;
}