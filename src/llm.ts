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
 * Server-side tools the model can reach for when a reply would benefit from
 * current information or computation. These run on Anthropic's infrastructure:
 * we just declare them and the model decides when to use them — there's no
 * client-side execution loop to write (unlike user-defined tools).
 *
 * `web_search`/`web_fetch` are the `_20260209` variants, which filter results
 * server-side before they enter the context window, keeping token cost down.
 * That filtering runs in a code-execution sandbox, so declaring these tools
 * makes the server *auto-inject* a `code_execution` tool — which is also what
 * gives the bot general code execution (arithmetic/data work in character).
 * We must NOT declare our own `code_execution` alongside them: the API rejects
 * the duplicate name ("Auto-injecting tools would conflict..."). The injected
 * tool covers the code-execution capability on its own.
 *
 * `max_uses` bounds web searches per reply — this is a chat bot, not a research
 * agent, so a low cap keeps both latency and the per-search cost in check.
 */
const SERVER_TOOLS: Anthropic.ToolUnion[] = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 },
];

/**
 * Safety cap on `pause_turn` continuations. Server tools run a server-side loop
 * that can pause mid-turn (`stop_reason: "pause_turn"`) so we can resume it;
 * this bounds how many times we'll do so before giving up on a single reply.
 */
const MAX_CONTINUATIONS = 5;

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
 * A completed chunk of the reply, ready to post as its own chat message. The
 * model emits text in distinct blocks across a turn — typically a remark before
 * a web search, then the answer built from the results — and we surface each as
 * a separate segment so callers can post them as they land.
 */
export type SegmentHandler = (text: string) => void | Promise<void>;

/**
 * Generates an in-character reply given the full conversation history (oldest
 * turn first, the latest user turn last).
 *
 * Streams the response and invokes `onSegment` once per completed text block,
 * as soon as that block finishes — so a "let me look that up" remark goes out
 * immediately, *before* the web search runs, and the answer follows once the
 * results are in. Each block is its own segment (its own chat message), which
 * is also why segments are never concatenated into one run-on string.
 *
 * Returns the full reply (segments joined with blank lines) for the caller to
 * store as one history turn, or null if the model declined or said nothing.
 */
export async function generateReply(
  history: HistoryMessage[],
  onSegment: SegmentHandler,
): Promise<string | null> {
  // The message list grows only when a server-tool turn pauses and we resume
  // it: we append the assistant's partial content and re-request. For a normal
  // reply this stays exactly equal to the history's message params.
  const messages = toMessageParams(history);

  // Each delivered segment, in order, for the combined history turn we return.
  const segments: string[] = [];

  // `contentBlock` fires synchronously as each block finalizes, but posting a
  // segment is async. We chain those posts so they run in order and so we can
  // await them all (and surface any send error) before returning.
  let delivery: Promise<void> = Promise.resolve();
  let refused = false;

  // The model doesn't emit one text block per message-worth of reply: it starts
  // a fresh text block every time a citation attaches mid-text, so a single
  // sentence can span several blocks. Posting each block separately therefore
  // splits sentences across messages. Instead we accumulate consecutive text
  // blocks here and flush only at real boundaries — when a server tool is about
  // to run (so the pre-search remark lands first) and at the end of the turn.
  let buffer = '';
  const flush = (): void => {
    const text = buffer.trim();
    buffer = '';
    if (text.length === 0) return;
    segments.push(text);
    delivery = delivery.then(() => onSegment(text));
  };

  for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
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
      messages,
      tools: SERVER_TOOLS,
    });

    // Accumulate text as it streams; flush the moment a server tool is invoked,
    // so the pre-search remark is posted while the (slow) search runs. We
    // concatenate raw block text — the whitespace that separates citation-split
    // blocks rides along with them, so joining verbatim reproduces the sentence.
    stream.on('contentBlock', (block) => {
      if (block.type === 'text') {
        buffer += block.text;
      } else if (block.type === 'server_tool_use') {
        flush();
      }
    });

    const message = await stream.finalMessage();

    if (message.stop_reason === 'refusal') {
      refused = true;
      break;
    }

    if (config.debug) {
      const { cache_read_input_tokens, cache_creation_input_tokens } =
        message.usage;
      const searches = message.usage.server_tool_use?.web_search_requests ?? 0;
      console.log(
        `Cache: ${cache_read_input_tokens ?? 0} read, ` +
          `${cache_creation_input_tokens ?? 0} written. ` +
          `Web searches: ${searches}.`,
      );
    }

    // The server-tool loop hit its iteration limit mid-turn. Append what it
    // produced and re-request so it picks up where it left off; the trailing
    // server_tool_use block is the signal the server uses to resume — we add
    // no extra user message.
    if (message.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: message.content });
      continue;
    }

    break;
  }

  // Post the trailing text (the post-search answer, or the whole reply when no
  // tool ran), then wait for every queued segment to finish posting — letting a
  // send failure propagate — before we report the turn as complete.
  flush();
  await delivery;

  if (refused) return null;
  const full = segments.join('\n\n');
  return full.length > 0 ? full : null;
}
