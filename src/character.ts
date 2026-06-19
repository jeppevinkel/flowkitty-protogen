import './env.js';

import { readFileSync } from 'node:fs';

/**
 * Character definition for the roleplay bot.
 *
 * This module defines the *shape* of a character and loads the *data* from a
 * JSON file at startup. The data lives outside source control (it describes who
 * the bot knows and where it may talk), so the live file is git-ignored. Copy
 * `character.example.json` to `character.json` and customise it, or point
 * `CHARACTER_FILE` at a file of your own.
 *
 * The `personality` string supports two template placeholders:
 *   {name}    -> replaced with `character.name`
 *   {people}  -> replaced with a rendered list of `character.people`
 */

export interface Person {
  /** The person's canonical Discord username (lowercase, no discriminator). */
  name: string;
  /** Other names the bot might hear this person called. Used for recognition. */
  aliases: string[];
  /** How the bot thinks/feels about this person, in the bot's own framing. */
  description: string;
}

export interface Character {
  /** The bot's in-character name. Substituted into `{name}` in the personality. */
  name: string;
  /** Names/aliases that, when mentioned in chat, should make the bot respond. */
  triggerNames: string[];
  /** The core personality prompt. Use {name} and {people} placeholders. */
  personality: string;
  /** People the bot knows about, rendered into the system prompt. */
  people: Person[];
  /**
   * Default channel IDs the bot may respond in. Empty array = respond anywhere.
   * Can be overridden at runtime via the ALLOWED_CHANNEL_IDS env var.
   */
  allowedChannelIds: string[];
}

/** Path to the JSON character definition. Overridable via CHARACTER_FILE. */
const CHARACTER_FILE = process.env.CHARACTER_FILE?.trim() || './character.json';

/** Reads and validates the character definition from `path`. */
function loadCharacter(path: string): Character {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `Could not read character file "${path}". ` +
        `Copy character.example.json to character.json and customise it, ` +
        `or set CHARACTER_FILE to point at your own file.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Character file "${path}" is not valid JSON: ${detail}`);
  }

  return validateCharacter(parsed, path);
}

/**
 * Validates the parsed JSON into a `Character`, throwing actionable errors.
 * `personality` may be supplied as a single string or an array of lines (joined
 * with newlines), so it stays readable when hand-edited in JSON.
 */
function validateCharacter(data: unknown, path: string): Character {
  const fail = (msg: string): never => {
    throw new Error(`Invalid character file "${path}": ${msg}`);
  };

  if (typeof data !== 'object' || data === null) {
    return fail('expected a JSON object at the top level.');
  }
  const obj = data as Record<string, unknown>;

  if (typeof obj.name !== 'string' || obj.name.trim() === '') {
    return fail('"name" must be a non-empty string.');
  }

  const triggerNames = asStringArray(obj.triggerNames);
  if (!triggerNames) return fail('"triggerNames" must be an array of strings.');

  let personality: string;
  if (typeof obj.personality === 'string') {
    personality = obj.personality;
  } else {
    const lines = asStringArray(obj.personality);
    if (!lines) {
      return fail('"personality" must be a string or an array of strings.');
    }
    personality = lines.join('\n');
  }

  if (!Array.isArray(obj.people)) {
    return fail('"people" must be an array.');
  }
  const people = obj.people.map((entry, index) =>
    validatePerson(entry, index, fail),
  );

  const allowedChannelIds = asStringArray(obj.allowedChannelIds);
  if (!allowedChannelIds) {
    return fail('"allowedChannelIds" must be an array of strings.');
  }

  return {
    name: obj.name.trim(),
    triggerNames,
    personality,
    people,
    allowedChannelIds,
  };
}

function validatePerson(
  entry: unknown,
  index: number,
  fail: (msg: string) => never,
): Person {
  if (typeof entry !== 'object' || entry === null) {
    return fail(`people[${index}] must be an object.`);
  }
  const p = entry as Record<string, unknown>;

  if (typeof p.name !== 'string' || p.name.trim() === '') {
    return fail(`people[${index}].name must be a non-empty string.`);
  }
  const aliases = asStringArray(p.aliases);
  if (!aliases) {
    return fail(`people[${index}].aliases must be an array of strings.`);
  }
  if (typeof p.description !== 'string') {
    return fail(`people[${index}].description must be a string.`);
  }

  return { name: p.name, aliases, description: p.description };
}

/** Returns the value as a string array, or null if it isn't one. */
function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((item) => typeof item === 'string')) return null;
  return value as string[];
}

export const character: Character = loadCharacter(CHARACTER_FILE);
