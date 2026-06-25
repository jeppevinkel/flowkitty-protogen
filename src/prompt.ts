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
  /** Present only when the incoming message is a reply. */
  replyingTo?: ReplyContext;
  /** Current Discord activities for the message author, if any are cached. */
  activities?: ActivityContext[];
}

/** The message this one is replying to, distilled for the prompt. */
export interface ReplyContext {
  authorDisplayName: string;
  authorUsername: string;
  /** Parent message text (already mention-cleaned). May be empty. */
  content: string;
  /** True when the parent was written by the bot itself. */
  isFromBot: boolean;
}

/** One Discord activity entry from the user's presence. */
export interface ActivityContext {
  /** 'PLAYING' | 'STREAMING' | 'LISTENING' | 'WATCHING' | 'CUSTOM' | 'COMPETING' */
  type: string;
  /** Activity name. For 'CUSTOM' this is always "Custom Status"; the actual text is in `state`. */
  name: string;
  /** Rich-presence detail line (e.g. "In a dungeon"). */
  details?: string;
  /** State line — for 'CUSTOM' this *is* the visible status text; for games, the game state. */
  state?: string;
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
    'or mention that you are an AI.',
    '',
    'Each incoming message is wrapped in a <message> tag whose attributes tell',
    'you who is speaking (from/username), when, and where (channel/server). The',
    'actual message is inside <text>. If the message is a reply, a <reply_to>',
    'element shows the message being replied to; from="you" means they are',
    'replying to something you said earlier. When present, an <activities>',
    'element captures what the user was doing on Discord (games, music, custom',
    'status, etc.) at the moment they sent that message — it is a snapshot in',
    'time, not a live feed, so activities on older messages describe what they',
    'were doing back then, and only the newest message reflects what someone is',
    'doing right now. Use all these details naturally but never repeat the tags,',
    'attributes, or context back to the user, and never emit tags of your own.',
    '',
    'You keep evolving, private notes about people you talk to. The fixed',
    '"People you know" descriptions above are your established, long-term sense of',
    'them. Separately, when the current speaker is someone you have notes on, a',
    '"notes about the current speaker" section is provided to you. Treat both as',
    'your genuine knowledge and let them shape your reply, but never quote them',
    'verbatim or reveal that you keep notes.',
    'When you learn something durable about someone worth recalling later — an',
    'interest, a life event, how they treat you — use the remember_person tool to',
    'record it (it replaces that person\'s note, so fold new facts into the old).',
    'Use recall_person to look up someone who is not the current speaker.',
  ].join('\n');

  return `${personality}\n${guidance}`;
}

function renderReply(reply: ReplyContext): string {
  const from = reply.isFromBot ? 'you' : xmlAttr(reply.authorDisplayName);
  const usernameAttr = reply.isFromBot
      ? ''
      : ` username="${xmlAttr(reply.authorUsername)}"`;
  const trimmed = reply.content.trim();
  const body =
      trimmed.length > 0 ? truncate(trimmed, MAX_REPLY_CHARS) : '(no text content)';
  return `  <reply_to from="${from}"${usernameAttr}>${xmlText(body)}</reply_to>`;
}

function renderActivities(activities: ActivityContext[]): string {
  const lines = activities.flatMap((a) => {
    let text: string;
    if (a.type === 'CUSTOM') {
      // `name` is just "Custom Status"; the actual status text lives in `state`.
      text = a.state ?? '';
    } else {
      text = [a.name, a.details, a.state].filter(Boolean).join(' — ');
    }
    if (!text) return [];
    return [`    <activity type="${xmlAttr(a.type.toLowerCase())}">${xmlText(text)}</activity>`];
  });

  if (lines.length === 0) return '';
  return ['  <activities>', ...lines, '  </activities>'].join('\n');
}

/** Renders one incoming message as a tagged block for a single user turn. */
export function buildUserMessage(ctx: MessageContext, timeZone = 'UTC'): string {
  const attrs = [
    `from="${xmlAttr(ctx.authorDisplayName)}"`,
    `username="${xmlAttr(ctx.authorUsername)}"`,
    `when="${xmlAttr(formatTimestamp(ctx.timestamp, timeZone))}"`,
    `channel="${xmlAttr(ctx.channelName)}"`,
    ...(ctx.serverName !== null ? [`server="${xmlAttr(ctx.serverName)}"`] : []),
  ].join(' ');

  const children: string[] = [];
  if (ctx.replyingTo) children.push(renderReply(ctx.replyingTo));
  if (ctx.activities && ctx.activities.length > 0) {
    const rendered = renderActivities(ctx.activities);
    if (rendered) children.push(rendered);
  }
  children.push(`  <text>${xmlText(ctx.content)}</text>`);

  return [`<message ${attrs}>`, ...children, '</message>'].join('\n');
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

/** Escape for use inside an XML attribute value. */
function xmlAttr(s: string): string {
  return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
}

/** Escape for use as XML element text (no quote handling needed). */
function xmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}

/** Cap quoted parent length so a long parent can't dominate the turn. */
const MAX_REPLY_CHARS = 300;
