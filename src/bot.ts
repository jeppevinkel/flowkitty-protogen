import { Client, type Message } from 'discord.js-selfbot-v13';
import { config } from './config.js';
import { character } from './character.js';
import { generateReply } from './llm.js';
import { appendMessage, popMessage } from './history.js';
import { buildUserMessage, type MessageContext } from './prompt.js';

/** Discord caps a single message at 2000 characters. */
const DISCORD_MAX_MESSAGE_LENGTH = 2000;

export function createBot(): Client {
  const client = new Client();

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
  if (!shouldRespond(client, message)) return;

  const ctx = extractContext(message);
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
    const reply = await generateReply(history);

    if (!reply) {
      if (config.debug) console.log('No reply generated (empty or refused).');
      return;
    }

    appendMessage(message.channelId, 'assistant', reply);

    if (config.debug) console.log(`Reply: ${reply}`);

    await deliver(message, splitMessage(reply));
  } catch (error) {
    // Drop the user turn we optimistically recorded so a failed request doesn't
    // leave a dangling, unanswered message poisoning future context.
    popMessage(message.channelId);
    console.error('Failed to handle message:', error);
  }
}

/** Decides whether an incoming message should trigger a response. */
function shouldRespond(client: Client, message: Message): boolean {
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
  return mentionsTriggerName(message.content);
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
function extractContext(message: Message): MessageContext {
  const author = message.author;
  const displayName =
    message.member?.nickname ?? author.globalName ?? author.username;

  const channel = message.channel;
  const channelName =
    'name' in channel && channel.name ? `#${channel.name}` : 'a direct message';

  return {
    authorDisplayName: displayName,
    authorUsername: author.username,
    timestamp: message.createdAt,
    channelName,
    serverName: message.guild?.name ?? null,
    // cleanContent resolves @mentions/#channels to readable names.
    content: message.cleanContent,
  };
}

/**
 * Sends the reply chunks back to the channel. If other messages have arrived
 * since the triggering message (the channel's last message is no longer the one
 * we're answering), we quote-reply so it's clear what the bot is responding to;
 * otherwise we send a plain message to avoid a redundant quote. Only the first
 * chunk carries the quote — trailing chunks are always plain continuations.
 */
async function deliver(message: Message, chunks: string[]): Promise<void> {
  const channel = message.channel;
  const canSend = 'send' in channel && typeof channel.send === 'function';
  const conversationMovedOn = channel.lastMessageId !== message.id;

  for (const [index, chunk] of chunks.entries()) {
    const quote = index === 0 && conversationMovedOn;
    if (quote || !canSend) {
      await message.reply(chunk);
    } else {
      await channel.send(chunk);
    }
  }
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
