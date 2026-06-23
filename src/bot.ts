import { Client, type Message } from 'discord.js-selfbot-v13';
import { config } from './config.js';
import { character } from './character.js';
import { generateReply } from './llm.js';
import { appendMessage, popMessage } from './history.js';
import {buildUserMessage, type MessageContext, type ReplyContext} from './prompt.js';
import {
  logDiscordMessage,
  registerHistoryFetcher,
  type DiscordLogMessage,
} from './discord-log.js';

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

      const fetched = await channel.messages.fetch({
        limit: count,
        ...(before ? { before } : {}),
      });

      return [...fetched.values()]
          .filter((m) => m.content.trim().length > 0)
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp) // oldest first
          .map((m): DiscordLogMessage => ({
            id: m.id,
            authorDisplayName:
                m.member?.nickname ?? m.author.globalName ?? m.author.username,
            content: m.cleanContent,
            timestamp: m.createdAt,
          }));
    } catch {
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

  // Record this turn, then hand the whole channel history to the model so it
  // has the conversation context. History is keyed per channel.
  const history = appendMessage(message.channelId, 'user', userMessage);

  if (config.debug) {
    console.log('--- Incoming trigger ---');
    console.log(userMessage);
  }

  try {
    await sendTyping(message);

    // The reply arrives in segments (e.g. a remark, then the post-search
    // answer); post each as its own message the moment it lands. generateReply
    // returns the combined text for history once the turn completes.
    const deliver = makeDeliverer(message);
    const reply = await generateReply(
        history,
        deliver,
        { channelId: message.channelId },
    );

    if (!reply) {
      if (config.debug) console.log('No reply generated (empty or refused).');
      return;
    }

    appendMessage(message.channelId, 'assistant', reply);

    if (config.debug) console.log(`Reply: ${reply}`);
  } catch (error) {
    // Drop the user turn we optimistically recorded so a failed request doesn't
    // leave a dangling, unanswered message poisoning future context.
    popMessage(message.channelId);
    console.error('Failed to handle message:', error);
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
  return {
    authorDisplayName: resolveDisplayName(message),
    authorUsername: message.author.username,
    timestamp: message.createdAt,
    channelName: resolveChannelName(message),
    serverName: message.guild?.name ?? null,
    // cleanContent resolves @mentions/#channels to readable names.
    content: message.cleanContent,
    replyingTo: await extractReply(client, message),
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
function makeDeliverer(message: Message): (text: string) => Promise<void> {
  const channel = message.channel;
  const canSend = 'send' in channel && typeof channel.send === 'function';
  let isFirstChunk = true;

  return async (text: string): Promise<void> => {
    for (const chunk of splitMessage(text)) {
      const quote = isFirstChunk && channel.lastMessageId !== message.id;
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
