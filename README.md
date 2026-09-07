# Pharmacy Management System — Backend

Node.js + TypeScript REST API with PostgreSQL, Prisma, and Better Auth.

## Requirements

- Node.js 20+
- PostgreSQL

## Setup

1. Copy `.env.example` to `.env` and fill in real values. Never commit `.env`.
2. Install dependencies: `npm install`
3. Apply migrations: `npm run prisma:migrate:dev`
4. Start in development: `npm run dev`

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server with reload |
| `npm run build` | Production TypeScript build |
| `npm start` | Run the compiled server |
| `npm test` | Run tests |
| `npm run typecheck` | TypeScript check |
| `npm run lint` | ESLint |
| `npm run prisma:migrate:dev` | Create/apply migrations locally |
| `npm run prisma:migrate:prod` | Apply migrations in production (`prisma migrate deploy`) |

## API prefixes

- Better Auth: `/api/auth/*`
- Application API: `/api/v1/*`
- Health: `GET /health`, `GET /health/ready`

Inventory, POS, purchasing, and related modules are not implemented in this phase.

Frontend authentication contract: [docs/FRONTEND_AUTH.md](docs/FRONTEND_AUTH.md)
