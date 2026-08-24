FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache openssl wget

# NODE_ENV was set nowhere, so Express returned a full stack trace on any
# unhandled synchronous throw — and this process holds decrypted Binance API
# keys, the database DSN and webhook secrets, any of which can appear inside an
# exception string (finding BOT-020).
ENV NODE_ENV=production
ENV DATABASE_URL=file:/app/data/bot.db

# The full dependency set, not --omit=dev: the entrypoint runs
# `prisma migrate deploy`, and the Prisma CLI is a devDependency. Omitting it
# would make the container try to fetch the CLI at startup, as a non-root user,
# from a network it may not have.
COPY package*.json ./
RUN npm ci && npm cache clean --force
COPY prisma ./prisma
RUN npx prisma generate
COPY --from=build /app/dist ./dist

# The container used to run as root. `node` is the unprivileged user the base
# image already provides; the data volume must be writable by it (finding BOT-029).
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 4000

# Without a healthcheck, a container whose event loop is wedged still reports
# healthy and `restart: unless-stopped` never intervenes (finding BOT-029).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:4000/health || exit 1

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
