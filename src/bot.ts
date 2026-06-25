import { Client, type Message } from 'discord.js-selfbot-v13';
import { config } from './config.js';
import { character } from './character.js';
import { generateReply } from './llm.js';
import {appendMessage, getHistory} from './history.js';
import {buildUserMessage, type MessageContext, type ReplyContext, type ActivityContext} from './prompt.js';
import {
  logDiscordMessage,
  registerHistoryFetcher,
  type DiscordLogMessage,
} from './discord-log.js';
import { shouldRespondOrganically } from './gate.js';
import { getMemory } from './memory.js';

/** Discord caps a single message at 2000 characters. */
const DISCORD_MAX_MESSAGE_LENGTH = 2000;

export function createBot(): Client {
  const client = new Client();

  // Wire up the Discord API fetcher so the summarise tool can backfill the
  // message log for history that predates the bot's current session.
  registerHistoryFetcher(async (channelId, count, before) => {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return [];

      const collected: Message[] = [];
      let cursor = before;

      // Discord caps a single fetch at 100; page backwards until we have `count`
      // messages or run out.
      while (collected.length < count) {
        const limit = Math.min(100, count - collected.length);
        const batch = await channel.messages.fetch({
          limit,
          ...(cursor ? { before: cursor } : {}),
        });
        if (batch.size === 0) break; // reached the beginning of the channel

        // The API returns newest-first; sort explicitly so the cursor is reliable
        // regardless of Collection iteration order.
        const ordered = [...batch.values()].sort(
            (a, b) => b.createdTimestamp - a.createdTimestamp,
        );
        collected.push(...ordered);
        // @ts-ignore
        cursor = ordered[ordered.length - 1].id; // oldest in this batch

        if (batch.size < limit) break; // no older messages remain
      }

      return collected
          .filter((m) => m.content.trim().length > 0)
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp) // oldest first
          .map((m): DiscordLogMessage => ({
            id: m.id,
            authorDisplayName:
                m.member?.nickname ?? m.author.globalName ?? m.author.username,
            content: m.cleanContent,
            timestamp: m.createdAt,
          }));
    } catch (error) {
      if (config.debug) console.warn('History backfill failed:', error);
      return []; // channel gone, no permission, rate-limited, etc.
    }
  });

  client.on('ready', () => {
    const tag = client.user?.tag ?? 'unknown user';
    console.log(`Logged in as ${tag}. Acting as character "${character.name}".`);
    if (config.allowedChannelIds.length > 0) {
      console.log(`Restricted to channels: ${config.allowedChannelIds.join(', ')}`);
    } else {
      console.log('Responding in all channels.');
    }
  });

  client.on('messageCreate', (message) => {
    void handleMessage(client, message);
  });

  client.on('error', (error) => {
    console.error('Discord client error:', error);
  });

  return client;
}

interface ChannelState {
  /** Aborts the stream of the generation currently running for this channel. */
  controller: AbortController;
  /** Has the current generation posted at least one chunk to the channel? */
  delivered: boolean;
  /** A triggering message arrived mid-generation; generate again when done. */
  queued: boolean;
  /** Newest triggering message — the reply anchor for the next generation. */
  anchor: Message;
}

const channels = new Map<string, ChannelState>();
/** channelId -> timestamp (ms) of the last organic (gated) response. */
const lastOrganicResponse = new Map<string, number>();

async function handleMessage(client: Client, message: Message): Promise<void> {
  // Log every non-empty message to the raw Discord log before anything else —
  // including messages that don't trigger the bot and the bot's own messages —
  // so the summarise tool has full channel context.
  if (message.content.trim().length > 0) {
    logDiscordMessage(message.channelId, {
      id: message.id,
      authorDisplayName: resolveDisplayName(message),
      content: message.cleanContent,
      timestamp: message.createdAt,
    });
  }

  if (!await shouldRespond(client, message)) return;

  const ctx = await extractContext(client, message);
  const userMessage = buildUserMessage(ctx, config.timezone);

  // Record the turn immediately so ordering is preserved and any generation we
  // (re)start sees it. History *is* the queue: a generation answers every user
  // turn since the last assistant turn.
  appendMessage(message.channelId, 'user', userMessage);

  if (config.debug) {
    console.log('--- Incoming trigger ---');
    console.log(userMessage);
  }

  const active = channels.get(message.channelId);
  if (active) {
    active.anchor = message; // newest message becomes the reply anchor
    active.queued = true;    // we'll generate again to address it
    if (!active.delivered) {
      // Nothing on screen yet — discard the in-progress reply and fold this
      // message into one combined reply (the driver loop restarts on abort).
      active.controller.abort();
    }
    // Already delivered: let the current reply finish; the loop then runs again
    // with this message *and the just-posted reply* in context.
    return;
  }

  const state: ChannelState = {
    controller: new AbortController(),
    delivered: false,
    queued: false,
    anchor: message,
  };
  channels.set(message.channelId, state);
  void runChannel(message.channelId, state);
}

async function runChannel(channelId: string, state: ChannelState): Promise<void> {
  try {
    do {
      state.queued = false;
      state.delivered = false;
      state.controller = new AbortController();
      const anchor = state.anchor;
      const history = getHistory(channelId);
      const speakerMemory = renderSpeakerMemory(anchor);

      try {
        await sendTyping(anchor);
        const deliver = makeDeliverer(anchor, () => { state.delivered = true; });
        const reply = await generateReply(
            history,
            deliver,
            { channelId },
            state.controller.signal,
            speakerMemory,
        );
        if (reply) {
          appendMessage(channelId, 'assistant', reply);
          if (config.debug) console.log(`Reply: ${reply}`);
        }
      } catch (error) {
        if (state.controller.signal.aborted) {
          // Superseded before anything was posted — loop again with the newer
          // anchor and the now-larger history.
          if (config.debug) console.log('Reply superseded; regenerating.');
          continue; // jumps to the while-condition, which queued=true keeps true
        }
        // Genuine failure (see note below).
        console.error('Failed to handle message:', error);
      }
    } while (state.queued);
  } finally {
    channels.delete(channelId);
  }
}

/** Decides whether an incoming message should trigger a response. */
async function shouldRespond(client: Client, message: Message): Promise<boolean> {
  // Never respond to ourselves, and ignore other bots to avoid loops.
  if (message.author.id === client.user?.id) return false;
  if (message.author.bot) return false;

  // Ignore empty messages (e.g. attachment-only).
  if (message.content.trim().length === 0) return false;

  // Enforce the channel allow-list when configured.
  if (
    config.allowedChannelIds.length > 0 &&
    !config.allowedChannelIds.includes(message.channelId)
  ) {
    return false;
  }

  // Respond if directly @-mentioned...
  if (client.user && message.mentions.has(client.user)) return true;

  // ...or if any of the character's trigger names appears in the text.
  if (mentionsTriggerName(message.content)) return true;

  if (message.reference?.messageId) {
    try {
      const parent = await message.fetchReference();
      if (parent.author.id === client.user?.id) return true;
    } catch {
      // Parent deleted or not fetchable — treat as "not a reply to me".
    }
  }

  // No explicit trigger. Optionally fall back to the gate classifier to decide
  // whether to chime in organically — but only past the per-channel cooldown,
  // so we cap both the classifier spend and how often the bot interjects.
  if (!config.organicResponses) return false;

  const now = Date.now();
  const last = lastOrganicResponse.get(message.channelId) ?? 0;
  if (now - last < config.organicCooldownMs) return false;

  if (await shouldRespondOrganically(message.channelId)) {
    lastOrganicResponse.set(message.channelId, now);
    return true;
  }
  return false;
}

/** Case-insensitive, word-boundary match against the character's names. */
function mentionsTriggerName(content: string): boolean {
  const lower = content.toLowerCase();
  return character.triggerNames.some((name) => {
    const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`).test(lower);
  });
}

/** Distills a Discord message into the plain shape the prompt layer wants. */
async function extractContext(
    client: Client,
    message: Message,
): Promise<MessageContext> {
  // Refresh the author's presence before we snapshot it, so the activity we
  // record reflects what they're doing now rather than a stale cached value.
  await refreshAuthorPresence(message);

  return {
    authorDisplayName: resolveDisplayName(message),
    authorUsername: message.author.username,
    timestamp: message.createdAt,
    channelName: resolveChannelName(message),
    serverName: message.guild?.name ?? null,
    // cleanContent resolves @mentions/#channels to readable names.
    content: message.cleanContent,
    replyingTo: await extractReply(client, message),
    activities: extractActivities(client, message),
  };
}

/**
 * Builds a segment sender for one reply. Each call posts a segment (splitting
 * over-long ones into Discord-sized chunks). If other messages arrived since
 * the triggering message, the very first chunk quote-replies so it's clear what
 * the bot is answering; everything after is a plain continuation. State is kept
 * in the closure because segments arrive across multiple calls over time (a
 * remark, then the post-search answer), not all at once.
 */
function makeDeliverer(
    message: Message,
    onDeliver: () => void,
): (text: string) => Promise<void> {
  const channel = message.channel;
  const canSend = 'send' in channel && typeof channel.send === 'function';
  let isFirstChunk = true;

  return async (text: string): Promise<void> => {
    for (const chunk of splitMessage(text)) {
      const quote = isFirstChunk && channel.lastMessageId !== message.id;
      if (isFirstChunk) onDeliver(); // mark delivered BEFORE awaiting the send
      isFirstChunk = false;
      if (quote || !canSend) {
        await message.reply(chunk);
      } else {
        await channel.send(chunk);
      }
    }
  };
}

/** Best-effort typing indicator; failures are non-fatal. */
async function sendTyping(message: Message): Promise<void> {
  const channel = message.channel;
  if ('sendTyping' in channel && typeof channel.sendTyping === 'function') {
    try {
      await channel.sendTyping();
    } catch {
      // Ignore — typing indicators are cosmetic.
    }
  }
}

/** Splits a reply into Discord-sized chunks, preferring line boundaries. */
function splitMessage(text: string): string[] {
  if (text.length <= DISCORD_MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > DISCORD_MAX_MESSAGE_LENGTH) {
    let cut = remaining.lastIndexOf('\n', DISCORD_MAX_MESSAGE_LENGTH);
    if (cut <= 0) cut = DISCORD_MAX_MESSAGE_LENGTH;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function resolveDisplayName(message: Message): string {
  const a = message.author;
  return message.member?.nickname ?? a.globalName ?? a.username;
}

function resolveChannelName(message: Message): string {
  const channel = message.channel;
  return 'name' in channel && channel.name ? `#${channel.name}` : 'a direct message';
}

async function extractReply(
    client: Client,
    message: Message,
): Promise<ReplyContext | undefined> {
  // Only normal replies have a referenced message id.
  if (!message.reference?.messageId) return undefined;

  let parent: Message;
  try {
    parent = await message.fetchReference();
  } catch {
    // Parent deleted or not fetchable — just omit reply context.
    return undefined;
  }

  return {
    authorDisplayName: resolveDisplayName(parent),
    authorUsername: parent.author.username,
    content: parent.cleanContent,
    isFromBot: parent.author.id === client.user?.id,
  };
}

/**
 * Forces Discord to push the author's current presence before we read it.
 *
 * Cached presence is only seeded at connect/guild-sync and kept current by
 * PRESENCE_UPDATE events, which a selfbot doesn't reliably receive for guild
 * members after that initial sync — so without this the cached activity freezes
 * at whatever the author was doing when the bot started (e.g. one Spotify
 * track). Fetching the member with `withPresences` sends a REQUEST_GUILD_MEMBERS
 * op — the same one the real client uses to resolve uncached members — and the
 * chunk reply refreshes the presence cache that extractActivities then reads.
 *
 * Best-effort and time-boxed so a slow, missing, or rate-limited reply never
 * stalls a response; on failure we just fall back to whatever is cached. DMs
 * are skipped because friend presences already stream in live.
 */
async function refreshAuthorPresence(message: Message): Promise<void> {
  const guild = message.guild;
  if (!guild) return;
  try {
    await guild.members.fetch({
      user: [message.author.id],
      withPresences: true,
      time: 3000,
    });
  } catch {
    // Offline, not found, timed out, or rate-limited — use the cached presence.
  }
}

/**
 * Reads the author's cached Discord presence activities.
 *
 * In a guild we have a GuildMember whose presence is populated directly.
 * In a DM (or when the member object is missing) we scan every shared guild
 * for a cached Presence — selfbot accounts receive friend presence updates
 * even outside of guilds, so one of those caches will usually have it.
 */
function extractActivities(client: Client, message: Message): ActivityContext[] {
  const presence =
      message.member?.presence ?? findUserPresence(client, message.author.id);
  if (!presence?.activities?.length) return [];

  return presence.activities
      .map((a) => ({
        type: String(a.type),
        name: a.name,
        ...(a.details != null ? { details: a.details } : {}),
        ...(a.state  != null ? { state:   a.state   } : {}),
      }))
      .filter((a) =>
          // Custom statuses with no state text are meaningless; other activities
          // need at least a name to be worth surfacing.
          a.type === 'CUSTOM' ? Boolean(a.state) : Boolean(a.name),
      );
}

/** Scans shared guilds for a cached Presence for `userId`. */
function findUserPresence(client: Client, userId: string) {
  for (const guild of client.guilds.cache.values()) {
    const presence = guild.presences.cache.get(userId);
    if (presence) return presence;
  }
  return null;
}

/** Renders the current speaker's stored notes into a system-prompt block. */
function renderSpeakerMemory(message: Message): string | undefined {
  const mem = getMemory(message.author.username);
  if (!mem) return undefined;
  const name = resolveDisplayName(message);
  return [
    '--- Your notes about the current speaker ---',
    `Your own evolving, private notes about ${name} (username: ${message.author.username}),`,
    'built from past conversations. Treat them as genuine knowledge and let them inform',
    'your reply, but never quote them verbatim or say that you keep notes.',
    '',
    mem.content,
  ].join('\n');
}
