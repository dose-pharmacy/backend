# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# deps — install prod Node dependencies once so they are cached independently
# of source changes.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma

RUN npm ci 

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
ENV TESSDATA_PREFIX=/usr/share/tessdata
ENV TESSERACT_PSM=6
# TESSERACT_TARGET_WIDTH is an upper bound only (small images are NOT
# enlarged). Tesseract is pinned to one OpenMP thread — on a CPU-limited
# instance the default thread pool oversubscribes the cgroup and the process
# appears to hang. OCR_MAX_CONCURRENCY bounds simultaneous Tesseract processes.
ENV TESSERACT_TARGET_WIDTH=1800
ENV TESSERACT_TIMEOUT_MS=60000
ENV TESSERACT_LANG=eng
ENV OMP_THREAD_LIMIT=1
ENV OMP_NUM_THREADS=1
ENV OCR_MAX_CONCURRENCY=1

# Runtime packages
RUN apk add --no-cache \
    openssl \
    tesseract-ocr \
    tesseract-ocr-data-eng \
    ca-certificates \
    wget

# Fail the build if Tesseract or its English data are missing from the FINAL
# (runtime) stage. A previous deploy shipped an image whose traineddata was
# absent, which only surfaced at request time.
RUN tesseract --version \
 && tesseract --list-langs \
 && test -f /usr/share/tessdata/eng.traineddata

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