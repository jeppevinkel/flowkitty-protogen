import type Anthropic from '@anthropic-ai/sdk';
import type { ToolContext, ToolDefinition } from './types.js';
import { summarizeTool } from './summarize.js';
import { recallPersonTool } from './recall-person.js';
import { rememberPersonTool } from './remember-person.js';


export type { ToolContext, ToolDefinition };

/**
 * All registered client-side tools.
 *
 * To add a new tool:
 *   1. Create src/tools/my-tool.ts exporting a ToolDefinition.
 *   2. Import it here and add it to REGISTERED_TOOLS.
 * Everything else — specs, dispatch, the llm loop — updates automatically.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REGISTERED_TOOLS: Array<ToolDefinition<any>> = [
    summarizeTool,
    recallPersonTool,
    rememberPersonTool,
];

/** Anthropic Tool specs to merge with SERVER_TOOLS in the API call. */
export const CLIENT_TOOL_SPECS: Anthropic.Tool[] = REGISTERED_TOOLS.map((t) => t.spec);

/**
 * Runs the named tool and returns its string result.
 * Returns an error string rather than throwing so the model receives
 * actionable feedback instead of crashing the turn.
 */
export async function executeTool(
    name: string,
    input: Record<string, unknown>,
    ctx: ToolContext,
): Promise<string> {
    const tool = REGISTERED_TOOLS.find((t) => t.spec.name === name);
    if (!tool) return `Unknown tool: "${name}".`;
    return tool.execute(input, ctx);
}