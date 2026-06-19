import { character, type Character, type Person } from './character.js';

/**
 * Details about a single incoming chat message, distilled from the Discord
 * message object into a plain shape the prompt layer can render. Keeping this
 * decoupled from discord.js types makes the prompt logic easy to test.
 */
export interface MessageContext {
  /** Display name of the author (server nickname, global name, or username). */
  authorDisplayName: string;
  /** The author's raw Discord username, used to match against known people. */
  authorUsername: string;
  /** When the message was sent. */
  timestamp: Date;
  /** Human-readable channel name, e.g. "#general", or "a direct message". */
  channelName: string;
  /** Server (guild) name, or null for DMs. */
  serverName: string | null;
  /** The message text, already cleaned of raw mention markup where possible. */
  content: string;
}

/** Renders the list of known people into a block for the system prompt. */
function renderPeople(people: Person[]): string {
  if (people.length === 0) return '';

  const lines = people.map((person) => {
    const aliasPart =
      person.aliases.length > 0
        ? ` (also known as: ${person.aliases.join(', ')})`
        : '';
    return `- ${person.name}${aliasPart}: ${person.description}`;
  });

  return ['People you know:', ...lines].join('\n');
}

/**
 * Builds the static system prompt that defines the bot's persona. This does not
 * change per message, so it can be cached and reused across requests.
 */
export function buildSystemPrompt(c: Character = character): string {
  const peopleBlock = renderPeople(c.people);

  const personality = c.personality
    .replaceAll('{name}', c.name)
    .replaceAll('{people}', peopleBlock);

  const guidance = [
    '',
    '--- Roleplay instructions ---',
    `You are ${c.name}. Stay fully in character at all times.`,
    'You are chatting in a Discord server. Reply as you would in a casual chat:',
    'keep responses fairly short and conversational, and never break character',
    'or mention that you are an AI. Each incoming message is prefixed with a',
    'context block describing who is speaking, when, and where — use those',
    'details naturally but do not repeat the context block back to the user.',
  ].join('\n');

  return `${personality}\n${guidance}`;
}

/**
 * Builds the per-message context block prepended to the user's message so the
 * model knows who is speaking, when, and where. The timestamp is rendered in
 * `timeZone` (an IANA name) so the bot's notion of "local time" is configurable.
 */
export function buildContextBlock(
  ctx: MessageContext,
  timeZone = 'UTC',
): string {
  const where =
    ctx.serverName !== null
      ? `in ${ctx.channelName} of the "${ctx.serverName}" server`
      : ctx.channelName;

  const lines = [
    '[Message context]',
    `From: ${ctx.authorDisplayName} (@${ctx.authorUsername})`,
    `When: ${formatTimestamp(ctx.timestamp, timeZone)}`,
    `Where: ${where}`,
    '[End context]',
  ];

  return lines.join('\n');
}

/** Combines the context block and the message body into one user turn. */
export function buildUserMessage(ctx: MessageContext, timeZone = 'UTC'): string {
  return `${buildContextBlock(ctx, timeZone)}\n\n${ctx.authorDisplayName}: ${ctx.content}`;
}

function formatTimestamp(date: Date, timeZone: string): string {
  // e.g. "Friday, 19 June 2026 at 23:49 UTC" / "...at 01:49 CEST"
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(date);
}
