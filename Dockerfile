# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# deps — install prod Node dependencies once so they are cached independently
# of source changes.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma

RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# build — transpile TS → JS into /app/build.
# ---------------------------------------------------------------------------
FROM deps AS build

COPY tsconfig.json ./
COPY src ./src

RUN npx prisma generate
RUN npm run build

# ---------------------------------------------------------------------------
# production — runtime image.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production
ENV TESSERACT_PATH=/usr/bin/tesseract
ENV TESSERACT_PSM=6
ENV TESSERACT_TARGET_WIDTH=1800
ENV TESSERACT_TIMEOUT_MS=30000

# Runtime packages
RUN apk add --no-cache \
    tesseract-ocr \
    ca-certificates \
    wget

# Non-root user
RUN addgroup -S app && adduser -S app -G app

# App files
COPY package.json package-lock.json ./
COPY prisma ./prisma

# Install runtime dependencies
RUN npm ci --omit=dev

# Generate Prisma client
RUN npx prisma generate

# Compiled application
COPY --from=build /app/build ./build

# Copy example env file if it exists
COPY .env.production.example .env

USER app

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/health || exit 1

CMD ["sh", "-c", "npx prisma migrate deploy && node build/server.js"]