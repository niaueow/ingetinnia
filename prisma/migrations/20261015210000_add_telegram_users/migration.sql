CREATE TABLE "telegram_users" (
    "chat_id" BIGINT NOT NULL,
    "first_name" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_users_pkey" PRIMARY KEY ("chat_id")
);
