# ingetinnia-backend

NestJS backend for the ingetinnia Telegram task manager bot.

## Stack

- NestJS 10
- Prisma 5
- PostgreSQL / Supabase
- Telegraf / nestjs-telegraf
- Node.js production runtime with PM2 on Ubuntu

## Setup

Create `.env` in the workspace root or this folder:

```text
DATABASE_URL=
DIRECT_URL=
TELEGRAM_BOT_TOKEN=
DISABLE_TELEGRAM=false
PORT=3000
```

For Supabase, use the pooler URL for `DATABASE_URL` at runtime and the direct database URL for `DIRECT_URL` during migrations.

```bash
npm install --legacy-peer-deps
npm run prisma:generate
npx prisma migrate deploy --schema ../prisma/schema.prisma
npm run build
npm run start:prod
```

## Development

```bash
npm run start:dev
npm test
```

## API

The REST API uses `userId=1` as a default single-user fallback when no query parameter is provided.

```text
POST   /tasks                 { "title": "...", "deadline": "2026-10-10T16:59:00.000Z" }
GET    /tasks
GET    /tasks/today
GET    /tasks/upcoming
PATCH  /tasks/:id/complete
PATCH  /tasks/:id/deadline    { "deadline": "..." }
DELETE /tasks/:id
```

## Telegram Bot

Available commands:

```text
/start
/add
/tasks
/today
/overdue
/done <judul>
/help
```

The `/add` flow asks for a title and then shows an inline WIB calendar for date, hour, and minute selection. The reminder worker runs every 30 seconds, sends pending reminders in batches, and marks overdue tasks.
