import { setMemory, MAX_MEMORY_CHARS } from '../memory.js';
import type { ToolDefinition } from './types.js';

interface RememberInput { username: string; notes: string; }

export const rememberPersonTool: ToolDefinition<RememberInput> = {
    spec: {
        name: 'remember_person',
        description:
            'Save or update your private, long-term notes about a person, identified by their ' +
            'Discord username (the username="..." value, NOT their display name). These are ' +
            'durable facts and impressions worth recalling in future conversations (interests, ' +
            'life events, how they relate to you) — not fleeting chatter. IMPORTANT: the notes ' +
            'you pass REPLACE the existing notes entirely, so include everything still worth ' +
            'keeping, merged with what is new. For the current speaker, your existing notes are ' +
            'already shown to you; for anyone else, call recall_person first so you do not ' +
            `overwrite what you knew. Keep it concise (under ${MAX_MEMORY_CHARS} characters). ` +
            'Pass empty notes to forget someone.',
        input_schema: {
            type: 'object',
            properties: {
                username: { type: 'string', description: "The person's Discord username (lowercase handle)." },
                notes: { type: 'string', description: 'The complete, updated note. Replaces any prior note.' },
            },
            required: ['username', 'notes'],
        },
    },
    async execute({ username, notes }) {
        const { content, truncated } = setMemory(username, notes);
        if (content.length === 0) return `Cleared your notes about "${username}".`;
        return truncated
            ? `Saved your notes about "${username}" (truncated to ${MAX_MEMORY_CHARS} chars).`
            : `Saved your notes about "${username}".`;
    },
};