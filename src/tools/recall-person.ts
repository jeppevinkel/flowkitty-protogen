import { getMemory } from '../memory.js';
import type { ToolDefinition } from './types.js';

interface RecallInput { username: string; }

export const recallPersonTool: ToolDefinition<RecallInput> = {
    spec: {
        name: 'recall_person',
        description:
            'Retrieve your saved personal notes about someone, identified by their Discord ' +
            'username (the username="..." value on their messages, NOT their display name). ' +
            'Use this to recall what you know about a person who is not the one currently ' +
            'speaking — e.g. when someone asks about them or they come up. Notes about the ' +
            'current speaker are already provided to you automatically.',
        input_schema: {
            type: 'object',
            properties: {
                username: { type: 'string', description: "The person's Discord username (lowercase handle)." },
            },
            required: ['username'],
        },
    },
    async execute({ username }) {
        const mem = getMemory(username);
        if (!mem) return `You have no saved notes about "${username}".`;
        return `Your notes about ${username} (updated ${mem.updatedAt}):\n${mem.content}`;
    },
};