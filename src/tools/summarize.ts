import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { getDiscordLog, ensurePopulated, DISCORD_LOG_SIZE } from '../discord-log.js';
import type { ToolContext, ToolDefinition } from './types.js';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

interface SummarizeInput {
    count?: number;
    query?: string;
}

const MAX_COUNT = DISCORD_LOG_SIZE; // 360 — defined by the store cap
const MIN_COUNT = 20;
const DEFAULT_COUNT = 60;

export const summarizeTool: ToolDefinition<SummarizeInput> = {
    spec: {
        name: 'summarize_history',
        description:
            'Returns a summary of the recent Discord chat in this channel, ' +
            'including messages from all users — not just our conversation. ' +
            'Use this to catch up on what was being discussed before you were involved, ' +
            'or to understand broader context you may not have seen. ' +
            'If you want to know about something specific (e.g. "did anyone mention the deploy?", ' +
            '"what did Sam decide about the schema?"), pass a `query` to focus the summary on that.',
        input_schema: {
            type: 'object',
            properties: {
                count: {
                    type: 'integer',
                    description:
                        `Number of recent Discord messages to summarise (${MIN_COUNT}–${MAX_COUNT}). ` +
                        `Defaults to ${DEFAULT_COUNT}.`,
                    minimum: MIN_COUNT,
                    maximum: MAX_COUNT,
                },
                query: {
                    type: 'string',
                    description:
                        'Optional. A specific question or topic to focus on. When provided, the ' +
                        'summary will answer this directly using concrete details from the chat ' +
                        '(who said what, decisions, specifics) rather than a generic overview. ' +
                        'Omit for a general summary of the conversation.',
                },
            },
        },
    },

    async execute(
        { count = DEFAULT_COUNT, query }: SummarizeInput,
        { channelId }: ToolContext
    ) {
        const clamped = Math.min(MAX_COUNT, Math.max(MIN_COUNT, count));
        await ensurePopulated(channelId, clamped);
        const messages = getDiscordLog(channelId, clamped);

        if (messages.length === 0) return 'No Discord message history available for this channel.';

        const transcript = messages
            .map((m) => {
                const time = m.timestamp.toLocaleTimeString('en-GB', {
                    hour: '2-digit',
                    minute: '2-digit',
                });
                return `[${time}] ${m.authorDisplayName}: ${m.content}`;
            })
            .join('\n');

        const trimmedQuery = query?.trim();

        const system = trimmedQuery
            ? 'You are answering a specific question about a Discord chat transcript. ' +
            'Use only the transcript to answer. Be concrete: cite specific details, who ' +
            'said what, decisions made, numbers, names, and timings where relevant — do not ' +
            'retreat to generic headings or vague overviews. ' +
            'If the transcript does not contain the answer, say so plainly rather than guessing. ' +
            'Keep it concise (a few sentences), but include the specifics that matter.'
            : 'Summarise the following Discord chat transcript concisely. ' +
            'Focus on the main topics discussed, any questions asked, and conclusions reached. ' +
            'Mention who was involved where relevant. Write in plain prose, 3–5 sentences.';

        const userContent = trimmedQuery
            ? `Question: ${trimmedQuery}\n\nTranscript:\n${transcript}`
            : transcript;

        const response = await client.messages.create({
            model: config.summarizerModel,
            max_tokens: 1024,
            system,
            messages: [{ role: 'user', content: userContent }],
        });

        const text = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('');

        return text || 'Unable to generate a summary.';
    },
};