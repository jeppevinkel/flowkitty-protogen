/**
 * Raw Discord message log per channel.
 *
 * Passively populated as messages arrive; backfilled on-demand from Discord's
 * API via the registered fetcher when the store is thin. The store is capped
 * at DISCORD_LOG_SIZE — the summariser's upper bound — so memory stays tight.
 */

/** Shared cap: how many messages to store AND the summariser's maximum. */
export const DISCORD_LOG_SIZE = 360;

export interface DiscordLogMessage {
    /** Discord snowflake ID — for deduplication and API pagination. */
    id: string;
    authorDisplayName: string;
    content: string;
    timestamp: Date;
}

/**
 * Fetches up to `count` messages for a channel.
 * If `before` is provided, only messages older than that snowflake ID are
 * returned. Results must be in chronological order (oldest first).
 */
export type HistoryFetcher = (
    channelId: string,
    count: number,
    before?: string,
) => Promise<DiscordLogMessage[]>;

const store = new Map<string, DiscordLogMessage[]>();
const pendingFetches = new Map<string, Promise<void>>();
let registeredFetcher: HistoryFetcher | null = null;

/**
 * Registers the Discord API fetcher. Call once at startup from wherever the
 * Discord client is available, before any tool calls can arrive.
 */
export function registerHistoryFetcher(fn: HistoryFetcher): void {
    registeredFetcher = fn;
}

/**
 * Appends a message to the channel log, evicting the oldest if at cap.
 * Silently skips duplicates (guards against overlap with a concurrent backfill).
 */
export function logDiscordMessage(channelId: string, msg: DiscordLogMessage): void {
    const log = store.get(channelId) ?? [];
    if (log.some((m) => m.id === msg.id)) return;
    log.push(msg);
    if (log.length > DISCORD_LOG_SIZE) log.shift();
    store.set(channelId, log);
}

/** Returns the last `count` messages for a channel, oldest first. */
export function getDiscordLog(channelId: string, count: number): DiscordLogMessage[] {
    return (store.get(channelId) ?? []).slice(-count);
}

/**
 * Ensures the channel store holds at least `needed` messages, backfilling
 * from Discord's API if it doesn't. Concurrent callers for the same channel
 * share a single in-flight fetch rather than racing.
 */
export async function ensurePopulated(channelId: string, needed: number): Promise<void> {
    const current = store.get(channelId) ?? [];
    if (current.length >= needed || !registeredFetcher) return;

    // If a backfill is already running for this channel, piggyback on it.
    const inflight = pendingFetches.get(channelId);
    if (inflight) {
        await inflight;
        return;
    }

    const fetch = (async () => {
        const cur = store.get(channelId) ?? [];
        const toFetch = DISCORD_LOG_SIZE - cur.length;
        const fetched = await registeredFetcher!(
            channelId,
            toFetch,
            cur[0]?.id, // fetch messages older than our oldest; undefined → most recent
        );
        // fetched is oldest-first; prepend to cur (also oldest-first), then dedup
        const merged = dedup([...fetched, ...cur]);
        store.set(channelId, merged.slice(-DISCORD_LOG_SIZE));
    })();

    pendingFetches.set(channelId, fetch);
    try {
        await fetch;
    } finally {
        pendingFetches.delete(channelId);
    }
}

function dedup(messages: DiscordLogMessage[]): DiscordLogMessage[] {
    const seen = new Set<string>();
    return messages.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
    });
}