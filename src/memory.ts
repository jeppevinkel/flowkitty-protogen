import fs from 'node:fs';
import { config } from './config.js';

export interface UserMemory {
    /** The bot's free-form, evolving notes about this person. */
    content: string;
    /** ISO timestamp of the last update. */
    updatedAt: string;
}

/** Hard cap per user — bounds prompt cost and forces the model to curate. */
export const MAX_MEMORY_CHARS = 2000;

/** lowercase username -> memory */
const memories = new Map<string, UserMemory>();

const key = (username: string): string => username.trim().toLowerCase();

function load(): void {
    let raw: string;
    try {
        raw = fs.readFileSync(config.memoryFile, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error(`Failed to read memory file "${config.memoryFile}":`, error);
        }
        return;
    }
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        for (const [username, value] of Object.entries(parsed)) {
            if (value && typeof value === 'object') {
                const { content, updatedAt } = value as Record<string, unknown>;
                if (typeof content === 'string' && typeof updatedAt === 'string') {
                    memories.set(key(username), { content, updatedAt });
                }
            }
        }
    } catch (error) {
        console.error(`Ignoring corrupt memory file "${config.memoryFile}":`, error);
    }
}

function save(): void {
    const tmp = `${config.memoryFile}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(memories), null, 2));
        fs.renameSync(tmp, config.memoryFile);
    } catch (error) {
        console.error(`Failed to persist memory to "${config.memoryFile}":`, error);
    }
}

load();

export function getMemory(username: string): UserMemory | undefined {
    return memories.get(key(username));
}

/** Overwrites (or clears, when blank) a user's notes. */
export function setMemory(username: string, content: string): { content: string; truncated: boolean } {
    const full = content.trim();
    const truncated = full.length > MAX_MEMORY_CHARS;
    const trimmed = full.slice(0, MAX_MEMORY_CHARS);
    if (trimmed.length === 0) {
        memories.delete(key(username));
    } else {
        memories.set(key(username), { content: trimmed, updatedAt: new Date().toISOString() });
    }
    save();
    return { content: trimmed, truncated };
}