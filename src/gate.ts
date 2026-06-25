import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { character } from './character.js';
import { getDiscordLog } from './discord-log.js';
import { logGateDecision } from './gate-log.js';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

/** How many recent channel messages to show the classifier as context. */
const GATE_CONTEXT_MESSAGES = 16;

/**
 * Routing classifier. The persona is intentionally minimal (name + trigger
 * names only) to keep per-call tokens — and therefore cost and latency — low.
 * The transcript marks the message under evaluation with ">>".
 */
const GATE_SYSTEM_PROMPT = [
    `You are a routing classifier for a Discord bot that role-plays as a character named "${character.name}"`,
    character.triggerNames.length > 0
        ? `(also addressed as: ${character.triggerNames.join(', ')}).`
        : '.',
    '',
    `Decide whether ${character.name} should naturally join the conversation in`,
    `response to the most recent message (marked with ">>"), even though the bot`,
    `was not explicitly @-mentioned or addressed by name.`,
    '',
    'Answer "YES" if the latest message:',
    `- is plausibly directed at ${character.name}, or continues a thread ${character.name} was part of;`,
    `- asks an open question to the room that ${character.name} would naturally answer;`,
    `- reacts to or invites a response to something ${character.name} just said.`,
    '',
    'Answer "NO" if the latest message:',
    `- is clearly part of a conversation between other people that doesn't involve ${character.name};`,
    '- is small talk, an aside, or otherwise needs no response from the character;',
    '- leaves you unsure. Default to NO to avoid interrupting.',
    '',
    'Respond with exactly one word: YES or NO. Do not explain.',
].join('\n');

/**
 * Asks the cheap "gate" model whether the bot should organically chime in,
 * based on recent channel context. Fails closed (returns false) on any error
 * so a flaky classifier call never makes the bot respond by accident.
 */
export async function shouldRespondOrganically(channelId: string): Promise<boolean> {
    const messages = getDiscordLog(channelId, GATE_CONTEXT_MESSAGES);
    if (messages.length === 0) return false;

    const transcript = messages
        .map((m, i) => {
            const marker = i === messages.length - 1 ? '>> ' : '';
            return `${marker}${m.authorDisplayName}: ${m.content}`;
        })
        .join('\n');

    try {
        const response = await client.messages.create({
            model: config.gateModel,
            max_tokens: 5,
            system: GATE_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: transcript }],
        });
        const text = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim()
            .toUpperCase();
        const decision = text.startsWith('YES');
        if (config.debug) {
            console.log(`Gate decision for ${channelId}: ${text || '(empty)'} -> ${decision}`);
        }
        logGateDecision({
            timestamp: new Date().toISOString(),
            channelId,
            decision,
            rawResponse: text || '(empty)',
            model: config.gateModel,
            transcript,
            inputTokens: response.usage?.input_tokens,
            outputTokens: response.usage?.output_tokens,
        });
        return decision;
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (config.debug) console.warn('Gate classification failed:', error);
        logGateDecision({
            timestamp: new Date().toISOString(),
            channelId,
            decision: false,
            rawResponse: `(error: ${detail})`,
            model: config.gateModel,
            transcript,
        });
        return false;
    }
}