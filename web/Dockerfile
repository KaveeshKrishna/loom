# ── Stage 1: Dependencies ──────────────────────────────────────────────────────
FROM node:26-alpine AS deps
WORKDIR /app

# Install build tools for native modules (sharp) and ffmpeg
RUN apk add --no-cache libc6-compat ffmpeg

COPY package.json ./
RUN npm install --legacy-peer-deps

# ── Stage 2: Builder ──────────────────────────────────────────────────────────
FROM node:26-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build Next.js
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── Stage 3: Runner ───────────────────────────────────────────────────────────
FROM node:26-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Install ffmpeg for video transcoding/probing
RUN apk add --no-cache ffmpeg

# Use the built-in node user (UID 1000) which matches host mount ownership

COPY --from=builder /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

# Copy Prisma schema/migrations + the generated client (the standalone
# Next.js output's dependency trace does not reliably pick up Prisma's
# native query engine, so this must be copied explicitly).
COPY --from=builder /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=node:node /app/node_modules/@prisma ./node_modules/@prisma

# The Prisma CLI (needed at startup to run `prisma migrate deploy`) is
# installed standalone here rather than copied from the app's node_modules,
# because the CLI's own transitive deps (e.g. `effect`, `jiti`) are not
# part of the traced/pruned dependency set the app itself needs at runtime.
# Keep this version in sync with the "prisma" devDependency in package.json.
RUN mkdir -p /opt/prisma-cli && \
    cd /opt/prisma-cli && \
    npm install prisma@6.11.1 --no-save --no-audit --no-fund && \
    chown -R node:node /opt/prisma-cli

COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh

USER node

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
