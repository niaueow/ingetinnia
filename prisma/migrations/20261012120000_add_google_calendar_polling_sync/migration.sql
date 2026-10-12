-- CreateEnum
CREATE TYPE "GoogleSyncJobOperation" AS ENUM ('UPSERT_EVENT', 'DELETE_EVENT', 'POLL_EVENTS');

-- CreateEnum
CREATE TYPE "GoogleSyncJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "tasks"
ADD COLUMN "google_calendar_id" TEXT,
ADD COLUMN "google_event_id" TEXT,
ADD COLUMN "google_event_updated_at" TIMESTAMP(3),
ADD COLUMN "last_synced_to_google_at" TIMESTAMP(3),
ADD COLUMN "last_synced_from_google_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "google_accounts" (
    "user_id" BIGINT NOT NULL,
    "google_user_id" TEXT,
    "email" TEXT,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "token_expiry" TIMESTAMP(3),
    "scopes" TEXT,
    "calendar_id" TEXT NOT NULL DEFAULT 'primary',
    "sync_token" TEXT,
    "last_polled_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_accounts_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "google_sync_jobs" (
    "id" TEXT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "task_id" TEXT,
    "operation" "GoogleSyncJobOperation" NOT NULL,
    "payload" JSONB,
    "status" "GoogleSyncJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "run_after" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tasks_user_id_google_event_id_idx" ON "tasks"("user_id", "google_event_id");

-- CreateIndex
CREATE INDEX "google_accounts_revoked_at_idx" ON "google_accounts"("revoked_at");

-- CreateIndex
CREATE INDEX "google_sync_jobs_status_run_after_idx" ON "google_sync_jobs"("status", "run_after");

-- CreateIndex
CREATE INDEX "google_sync_jobs_user_id_status_idx" ON "google_sync_jobs"("user_id", "status");

-- CreateIndex
CREATE INDEX "google_sync_jobs_task_id_operation_status_idx" ON "google_sync_jobs"("task_id", "operation", "status");

-- AddForeignKey
ALTER TABLE "google_sync_jobs" ADD CONSTRAINT "google_sync_jobs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
