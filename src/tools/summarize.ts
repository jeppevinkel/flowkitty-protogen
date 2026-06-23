import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { getDiscordLog, ensurePopulated, DISCORD_LOG_SIZE } from '../discord-log.js';
import type { ToolContext, ToolDefinition } from './types.js';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

interface SummarizeInput {
    count?: number;
}

const MAX_COUNT = DISCORD_LOG_SIZE; // 360 — defined by the store cap
const MIN_COUNT = 20;
const DEFAULT_COUNT = 60;

export const summarizeTool: ToolDefinition<SummarizeInput> = {
    spec: {
        name: 'summarize_history',
        description:
            'Returns a concise summary of the recent Discord chat in this channel, ' +
            'including messages from all users — not just our conversation. ' +
            'Use this to catch up on what was being discussed before you were involved, ' +
            'or to understand broader context you may not have seen.',
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
            },
        },
    },

    async execute({ count = DEFAULT_COUNT }: SummarizeInput, { channelId }: ToolContext) {
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

        const response = await client.messages.create({
            model: config.summarizerModel,
            max_tokens: 512,
            system:
                'Summarise the following Discord chat transcript concisely. ' +
                'Focus on the main topics discussed, any questions asked, and conclusions reached. ' +
                'Mention who was involved where relevant. Write in plain prose, 3–5 sentences.',
            messages: [{ role: 'user', content: transcript }],
        });

        const text = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('');

        return text || 'Unable to generate a summary.';
    },
};