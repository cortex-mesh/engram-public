# Engram — Multi-stage Next.js standalone build
# Runs on port 3104 (CORTEX auth & identity service)

# --- Stage 1: Install dependencies ---
FROM node:22-alpine AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci

# --- Stage 2: Build ---
FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_AUDIT=false
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

# --- Stage 3: Run ---
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3104
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_AUDIT=false

# Reuse the already-installed dependency tree so the runtime stage does not
# perform a second network install. Keep production deps, including Prisma CLI
# transitive deps used by one-shot migration hooks.
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
RUN npm prune --omit=dev && npm cache clean --force --loglevel=error

# Copy standalone server + static assets
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static

# Copy Prisma migrations and operational scripts used by deploy hooks.
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY --from=build /app/scripts ./scripts

# Copy entrypoint
COPY --from=build /app/docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Run as the built-in non-root `node` user (audit #11) so any RCE runs
# unprivileged instead of as root. The entrypoint only execs `node server.js`
# (port 3104, unprivileged) or the one-shot `prisma migrate deploy` — neither
# needs root, and nothing writes to the app dir at runtime (Prisma uses /tmp).
RUN chown -R node:node /app
USER node

EXPOSE 3104

ENTRYPOINT ["./docker-entrypoint.sh"]
