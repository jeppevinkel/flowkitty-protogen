import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { buildSystemPrompt } from './prompt.js';
import type { HistoryMessage } from './history.js';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

// The persona prompt is static, so build it once and reuse (and cache) it.
const SYSTEM_PROMPT = buildSystemPrompt();

/** Max tokens for a reply. Chat responses are short, so this is generous. */
const MAX_TOKENS = 1024;

/**
 * Converts our plain history turns into Anthropic message params, marking the
 * final turn with a cache breakpoint.
 *
 * Caching is a prefix match: everything up to a `cache_control` breakpoint is
 * cached as a unit. Because our history is append-only (users can't edit past
 * messages), the bytes before the newest turn never change, so each request
 * reads the prefix the previous request wrote and only the latest turn is
 * processed fresh. Marking the last turn is what extends the cache forward for
 * the next request. Combined with the cached system prompt, that's 2 of the 4
 * allowed breakpoints.
 */
function toMessageParams(history: HistoryMessage[]): Anthropic.MessageParam[] {
  return history.map((message, index) => {
    const isLast = index === history.length - 1;
    return {
      role: message.role,
      content: [
        {
          type: 'text',
          text: message.content,
          ...(isLast ? { cache_control: { type: 'ephemeral' } } : {}),
        },
      ],
    };
  });
}

/**
 * Generates an in-character reply given the full conversation history (oldest
 * turn first, the latest user turn last).
 *
 * Streams the response (recommended for any non-trivial request) and returns
 * the assembled text, or null if the model declined to respond.
 */
export async function generateReply(
  history: HistoryMessage[],
): Promise<string | null> {
  const stream = client.messages.stream({
    model: config.model,
    max_tokens: MAX_TOKENS,
    // Adaptive thinking lets Claude decide how much to reason; low effort keeps
    // casual chat replies snappy. Thinking text is omitted by default.
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: toMessageParams(history),
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    return null;
  }

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  if (config.debug) {
    const { cache_read_input_tokens, cache_creation_input_tokens } =
      message.usage;
    console.log(
      `Cache: ${cache_read_input_tokens ?? 0} read, ` +
        `${cache_creation_input_tokens ?? 0} written.`,
    );
  }

  return text.length > 0 ? text : null;
}
