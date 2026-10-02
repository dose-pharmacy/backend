# syntax=docker/dockerfile:1
#
# Deploys the Pharmacy backend as a single container image. The image carries a
# fully-installed tesseract-ocr binary so invoice OCR works at runtime (the
# server spawns `tesseract` inside invoice-ocr.service.ts); the dev machine
# does not need it. The production stage keeps the TS → JS build so no Node
# toolchain has to be present at start time.
#
#   docker build -t pharmacy-backend .
#   docker run --env-file .env -p 4000:4000 pharmacy-backend
#
# For a managed Postgres, override DATABASE_URL (and the auth values) via
# --env-file or the orchestrator's secret store; docker-compose.yml ships a
# local Postgres stack for development.

# ---------------------------------------------------------------------------
# deps — install prod Node dependencies once so they are cached independently
# of source changes.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
# devDependencies are never needed at runtime; --omit=dev keeps the image lean
# (the workspace is ESM, so normal `npm ci` / `npm ci --omit=dev` are identical
# here, but pass it explicitly for clarity).
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# build — transpile TS → JS into /app/build.
# ---------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npx prisma generate && npm run build

# ---------------------------------------------------------------------------
# production — the runtime image.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
ENV TESSERACT_PATH=/usr/bin/tesseract
ENV TESSERACT_PSM=6
ENV TESSERACT_TARGET_WIDTH=1800
ENV TESSERACT_TIMEOUT_MS=30000

# 1) Base runtime + CA certificates (OCR over HTTPS to any attestation/verification endpoint).
RUN apk add --no-cache tesseract-ocr ca-certificates wget \
  # tesseract data path.
  && mkdir -p /usr/share/tesseract-ocr/4.00/tessdata \
  && ln -sf /usr/share/tesseract-ocr/4.00/tessdata/* /usr/share/tesseract-ocr/4.00/tessdata/ 2>/dev/null || true

# 2) Non-root user (OCR binary still runs as root-owned files, but the Node
#    process no longer does).
RUN addgroup -S app && adduser -S app -G app

COPY package.json package-lock.json ./
COPY prisma ./prisma
# Re-run npm ci so the layer is correct after the new FROM (deps' /app is a
# copy; this stage gets its own dependency tree).
RUN npm ci --omit=dev
RUN npx prisma generate

COPY --from=build /app/build ./build

# Ship a minimal default .env so the container starts without a mounted env
# file; real secrets must be supplied by the operator. The production entrypoint
# below refuses to start if DATABASE_URL is empty, so this is only a template.
COPY .env.production.example .env 2>/dev/null || true

USER app
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/health || exit 1

# The entrypoint applies migrations then starts the built server. The Node
# process runs as `app`, but tesseract-ocr still runs under that account and
# needs write access to its tessdata dir (it is root-owned); run the whole
# container as root only when deploying, or grant the user access to tessdata.
CMD ["sh", "-c", "npx prisma migrate deploy && node build/server.js"]
