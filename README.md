# flowkitty-protogen

A roleplaying Discord bot that responds in character based on a personality
system prompt, powered by [Claude](https://www.anthropic.com/claude) and
[discord.js-selfbot-v13](https://github.com/aiko-chan-ai/discord.js-selfbot-v13).

The bot listens for messages that either **@-mention it** or **contain one of
its names**, and replies in character. Each reply is generated with context
about who sent the message, when, and in which channel/server.

> ⚠️ **Heads up:** this uses a *self-bot* (it automates a real user account).
> That is against Discord's Terms of Service and can get the account banned.
> Use a throwaway account, only in servers where you have permission, and at
> your own risk.

## Setup

1. **Install dependencies:**

   ```sh
   npm install
   ```

2. **Configure secrets.** A `.env` file was created for you (copied from
   `.env.example`). Fill in:

   - `DISCORD_TOKEN` — the user token for the account the bot runs as.
   - `ANTHROPIC_API_KEY` — your Anthropic API key from
     <https://console.anthropic.com/>.

   Optional overrides (see `.env.example`): `ANTHROPIC_MODEL`,
   `ALLOWED_CHANNEL_IDS`, `DEBUG`.

3. **Run it:**

   ```sh
   npm run dev     # watch mode (tsx), no build step
   # or
   npm run build && npm start
   ```

## Customizing the character

Who the bot is lives in a JSON file, **not** in source — it describes real
people and channels, so it is kept out of git. Copy the template and edit it:

```sh
cp character.example.json character.json
```

`character.json` is git-ignored; `character.example.json` is the committed
template that documents the shape. The fields:

- `name` — the bot's in-character name (substituted into the personality).
- `triggerNames` — words that make the bot respond when they appear in chat.
- `personality` — the core persona prompt. May be a single string or an array
  of lines (joined with newlines). Supports `{name}` and `{people}`
  placeholders.
- `people` — people the bot knows, each with `name`, `aliases`, `description`.
- `allowedChannelIds` — default channels the bot may talk in (empty = anywhere;
  overridable via the `ALLOWED_CHANNEL_IDS` env var).

To load a different file, set `CHARACTER_FILE` in `.env`. The schema is defined
and validated in [`src/character.ts`](src/character.ts).

## Project layout

| File                 | Responsibility                                              |
| -------------------- | ----------------------------------------------------------- |
| `src/index.ts`       | Entry point: starts the client, handles graceful shutdown.  |
| `src/config.ts`      | Loads & validates environment variables.                    |
| `src/character.ts`   | The character definition (persona, people, channels).       |
| `src/prompt.ts`      | Builds the system prompt and per-message context block.     |
| `src/llm.ts`         | Anthropic client wrapper (Claude Opus 4.8, streaming).      |
| `src/bot.ts`         | Discord client: trigger logic, context extraction, replies. |

## Scripts

| Script             | Description                                  |
| ------------------ | -------------------------------------------- |
| `npm run dev`      | Run in watch mode with `tsx`.                |
| `npm run build`    | Compile TypeScript to `dist/`.               |
| `npm start`        | Run the compiled output.                     |
| `npm run typecheck`| Type-check without emitting.                 |

## Roadmap / not yet implemented

This scaffold covers single-message, mention-triggered replies. Natural
next steps: conversation history/threading, rate limiting, reacting to edits,
and per-user memory.
