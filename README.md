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

## Running with Docker

A multi-stage [`Dockerfile`](Dockerfile) builds the project and produces a small
runtime image. Images are published to the GitHub Container Registry on every
push to `master` and on version tags:

```
ghcr.io/jeppevinkel/flowkitty-protogen:latest
```

The container is configured entirely through environment variables (the same
ones as `.env`) and two mounts:

- `/app/data` — where conversation history is persisted; mount a volume so it
  survives restarts.
- `/app/character.json` — the example character is baked in as a default; mount
  your own file to override it with real persona/people/channels.

### Docker Compose (recommended)

A [`compose.yml`](compose.yml) is included. With your `.env` filled in and a
`character.json` in place:

```sh
docker compose up -d
```

This pulls the published image, loads secrets from `.env`, persists history to
`./data`, and mounts your `./character.json` read-only. To build the image
locally instead of pulling, comment out `image:` and uncomment `build: .` in
`compose.yml`.

View logs and stop:

```sh
docker compose logs -f
docker compose down
```

### Plain `docker run`

```sh
docker run -d --name flowkitty --restart unless-stopped \
  --env-file .env \
  -v "$PWD/data:/app/data" \
  -v "$PWD/character.json:/app/character.json:ro" \
  ghcr.io/jeppevinkel/flowkitty-protogen:latest
```

To build the image yourself:

```sh
docker build -t flowkitty-protogen .
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
