/**
 * Conversation history, keyed per channel and persisted to a JSON file.
 *
 * History is append-only: a user can't go back and edit a prior message, so the
 * stored turns for a channel form a stable prefix. That property is what makes
 * prompt caching effective (see src/llm.ts) — every byte before the newest turn
 * is identical request-to-request, so the model serves it from cache.
 *
 * The store is mirrored to `config.historyFile` so conversations survive a
 * restart: it's loaded once at module init and rewritten after every mutation.
 * Writes are synchronous and atomic (temp file + rename); given the bot's low
 * message rate the blocking cost is negligible and durability is simpler than
 * coordinating an async flush on shutdown.
 */

import fs from 'node:fs';
import { config } from './config.js';

/** A single turn in a conversation, decoupled from the Anthropic SDK types. */
export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Maximum number of messages retained per channel. When exceeded, the oldest
 * messages are dropped. Keep this generous: trimming changes the cached prefix
 * and forces the next request to rebuild the cache, so we'd rather trim rarely.
 */
const MAX_MESSAGES = config.maxHistoryMessages;

/** channelId -> ordered list of turns, oldest first. */
const histories = new Map<string, HistoryMessage[]>();

/** Trims a channel's history in place to the most recent MAX_MESSAGES turns. */
function trim(history: HistoryMessage[]): void {
  if (history.length > MAX_MESSAGES) {
    history.splice(0, history.length - MAX_MESSAGES);
  }
}

/** Narrows arbitrary parsed JSON into a HistoryMessage, or null if malformed. */
function toHistoryMessage(value: unknown): HistoryMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const { role, content } = value as Record<string, unknown>;
  if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') {
    return null;
  }
  return { role, content };
}

/**
 * Loads persisted history from disk into the in-memory map. A missing file is
 * the normal first-run case (start empty); a corrupt file is logged and skipped
 * rather than crashing the bot.
 */
function load(): void {
  let raw: string;
  try {
    raw = fs.readFileSync(config.historyFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`Failed to read history file "${config.historyFile}":`, error);
    }
    return;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [channelId, turns] of Object.entries(parsed)) {
      if (!Array.isArray(turns)) continue;
      const messages = turns
        .map(toHistoryMessage)
        .filter((m): m is HistoryMessage => m !== null);
      trim(messages);
      histories.set(channelId, messages);
    }
  } catch (error) {
    console.error(`Ignoring corrupt history file "${config.historyFile}":`, error);
  }
}

/**
 * Persists the whole map to disk atomically: write a temp file, then rename it
 * over the target so a crash mid-write can never leave a truncated file. Disk
 * errors are logged but swallowed — losing persistence must not take the bot
 * down.
 */
function save(): void {
  const tmp = `${config.historyFile}.tmp`;
  try {
    const data = JSON.stringify(Object.fromEntries(histories));
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, config.historyFile);
  } catch (error) {
    console.error(`Failed to persist history to "${config.historyFile}":`, error);
  }
}

// Restore any prior conversation before the bot starts handling messages.
load();

/** Returns the (live) history array for a channel, creating it if needed. */
function ensure(channelId: string): HistoryMessage[] {
  let history = histories.get(channelId);
  if (!history) {
    history = [];
    histories.set(channelId, history);
  }
  return history;
}

/**
 * Appends a turn to a channel's history and trims the oldest turns if the cap
 * is exceeded. Returns a snapshot of the channel's history after appending.
 */
export function appendMessage(
  channelId: string,
  role: HistoryMessage['role'],
  content: string,
): HistoryMessage[] {
  const history = ensure(channelId);
  history.push({ role, content });
  trim(history);
  save();

  return history.slice();
}

/** Returns a snapshot of a channel's history (empty if none yet). */
export function getHistory(channelId: string): HistoryMessage[] {
  return ensure(channelId).slice();
}

/** Removes the most recent turn from a channel's history, if any. */
export function popMessage(channelId: string): void {
  const history = histories.get(channelId);
  if (history && history.length > 0) {
    history.pop();
    save();
  }
}
