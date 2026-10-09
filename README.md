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
For Telegram reminders, `userId` must be the recipient's numeric Telegram chat ID.
The recipient must also send `/start` to the bot first because Telegram bots cannot
start a conversation with a user. For example:

```text
POST   /tasks                 { "title": "...", "deadline": "2026-10-10T16:59:00.000Z" }
GET    /tasks
GET    /tasks/today
GET    /tasks/upcoming
PATCH  /tasks/:id/complete
PATCH  /tasks/:id/deadline    { "deadline": "..." }
PATCH  /tasks/:id             { "title": "...", "deadline": "...", "status": "PENDING" }
DELETE /tasks                 { "taskIds": ["task-id-1", "task-id-2"] }
DELETE /tasks/:id
```

When creating a task through the API, pass the Telegram chat ID explicitly:

```text
POST /tasks { "title": "...", "deadline": "...", "userId": "<telegram-chat-id>" }
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
/edit <taskId>
/bulkdelete
/help
```

The `/add` flow asks for a title and then shows an inline WIB calendar for date, hour, and minute selection.
From `/tasks`, use **Edit** to change a task title, deadline, or status. `/edit <taskId>`
opens the same editor directly. `/bulkdelete` displays active and completed tasks with
checkboxes, plus actions for deleting all completed or all pending tasks.
The reminder worker runs every 30 seconds, sends pending reminders in batches, and marks overdue tasks.
If Telegram reports that a recipient chat does not exist, is blocked, or is deactivated,
the affected reminder is marked `CANCELLED` so the worker does not retry it forever.
