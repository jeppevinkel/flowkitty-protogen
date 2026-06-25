import './env.js';

import { character } from './character.js';

/** Reads a required environment variable, throwing a helpful error if missing. */
function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable "${name}". ` +
        `Copy .env.example to .env and fill it in.`,
    );
  }
  return value.trim();
}

function parseChannelIds(raw: string | undefined): string[] {
  if (!raw) return character.allowedChannelIds;
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/**
 * Validates an IANA timezone name (e.g. "Europe/Copenhagen"), defaulting to UTC.
 * This is the time the bot considers "local" when stamping message context.
 */
function parseTimezone(raw: string | undefined): string {
  const tz = raw?.trim() || 'UTC';
  try {
    // Constructing a formatter throws a RangeError for an unknown zone.
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
  } catch {
    throw new Error(
      `Invalid TIMEZONE "${tz}". Use an IANA timezone name ` +
        `like "Europe/Copenhagen", "America/New_York", or "UTC".`,
    );
  }
  return tz;
}

/**
 * Parses a positive-integer message cap, falling back to `fallback` (with a
 * warning) for missing, non-numeric, or non-positive values.
 */
function parseMaxHistoryMessages(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    console.warn(
      `Invalid MAX_HISTORY_MESSAGES "${raw}"; expected a positive integer. ` +
        `Falling back to ${fallback}.`,
    );
    return fallback;
  }
  return value;
}

/** Parses a non-negative duration in seconds into milliseconds. */
function parseCooldownMs(raw: string | undefined, fallbackSeconds: number): number {
  if (raw === undefined || raw.trim() === '') return fallbackSeconds * 1000;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0) {
    console.warn(
        `Invalid ORGANIC_COOLDOWN_SECONDS "${raw}"; expected a non-negative number. ` +
        `Falling back to ${fallbackSeconds}s.`,
    );
    return fallbackSeconds * 1000;
  }
  return value * 1000;
}

/** Parses a non-negative size in MB into bytes. 0 disables log rotation. */
function parseLogMaxBytes(raw: string | undefined, fallbackMb: number): number {
  if (raw === undefined || raw.trim() === '') return fallbackMb * 1024 * 1024;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0) {
    console.warn(
        `Invalid GATE_LOG_MAX_MB "${raw}"; expected a non-negative number. ` +
        `Falling back to ${fallbackMb} MB.`,
    );
    return fallbackMb * 1024 * 1024;
  }
  return Math.floor(value * 1024 * 1024);
}

export interface Config {
  discordToken: string;
  anthropicApiKey: string;
  model: string;
  summarizerModel: string;
  /** Channel IDs the bot may respond in. Empty array means "respond anywhere". */
  allowedChannelIds: string[];
  /** IANA timezone the bot treats as its local time in message context. */
  timezone: string;
  /** Max turns retained per channel before the oldest are dropped. */
  maxHistoryMessages: number;
  /** Path to the JSON file conversation history is persisted to. */
  historyFile: string;
  /** When true, use the gate model to decide on organic (untriggered) replies. */
  organicResponses: boolean;
  /** Cheap model used to classify whether to respond organically. */
  gateModel: string;
  /** Minimum gap between organic responses per channel (ms). */
  organicCooldownMs: number;
  /** Path to the JSONL gate-decision log. Empty string disables logging. */
  gateLogFile: string;
  /** Max bytes for the active gate log before it rotates. 0 disables rotation. */
  gateLogMaxBytes: number;
  debug: boolean;
}

export const config: Config = {
  discordToken: required('DISCORD_TOKEN'),
  anthropicApiKey: required('ANTHROPIC_API_KEY'),
  model: process.env.ANTHROPIC_MODEL?.trim() || 'claude-opus-4-8',
  summarizerModel: process.env.ANTHROPIC_SUMMARIZER_MODEL?.trim() || 'claude-haiku-4-5',
  allowedChannelIds: parseChannelIds(process.env.ALLOWED_CHANNEL_IDS),
  timezone: parseTimezone(process.env.TIMEZONE),
  maxHistoryMessages: parseMaxHistoryMessages(process.env.MAX_HISTORY_MESSAGES, 40),
  historyFile: process.env.HISTORY_FILE?.trim() || './data/history.json',
  organicResponses: process.env.ORGANIC_RESPONSES?.trim().toLowerCase() === 'true',
  gateModel: process.env.ANTHROPIC_GATE_MODEL?.trim() || 'claude-haiku-4-5',
  organicCooldownMs: parseCooldownMs(process.env.ORGANIC_COOLDOWN_SECONDS, 30),
  gateLogFile: process.env.GATE_LOG_FILE?.trim() ?? './data/gate-decisions.jsonl',
  gateLogMaxBytes: parseLogMaxBytes(process.env.GATE_LOG_MAX_MB, 2),
  debug: process.env.DEBUG?.trim().toLowerCase() === 'true',
};
