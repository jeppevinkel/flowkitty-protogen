# syntax=docker/dockerfile:1

# --- Build stage ------------------------------------------------------------
# Install full deps (incl. dev) and compile TypeScript -> dist/.
FROM node:22-alpine AS build
WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Compile.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Production deps stage --------------------------------------------------
# A clean install of only runtime dependencies, kept separate from the build
# stage so the final image carries no dev tooling.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Runtime stage ----------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Runtime dependencies and compiled output.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Ship the example character as the default character.json. Mount your own
# (or set CHARACTER_FILE) to override it with real persona/people/channels.
COPY character.example.json ./character.json

# History is persisted to ./data/history.json by default — keep it on a volume
# so conversations survive container restarts.
RUN mkdir -p data && chown -R node:node /app
VOLUME ["/app/data"]

USER node
CMD ["npm", "start"]
