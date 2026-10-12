import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GoogleAccount, Prisma, Task, TaskStatus } from '@prisma/client';
import { google, calendar_v3 } from 'googleapis';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { Telegraf } from 'telegraf';
import { PrismaService } from '../prisma.service.js';

const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];
const PRIVATE_SYNC_SOURCE = 'ingetinnia';
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

type OAuthTokens = {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
  scope?: string | null;
};

type LinkedTask = Pick<
  Task,
  | 'id'
  | 'userId'
  | 'title'
  | 'deadline'
  | 'status'
  | 'googleCalendarId'
  | 'googleEventId'
  | 'googleEventUpdatedAt'
  | 'updatedAt'
>;

@Injectable()
export class GoogleCalendarService implements OnModuleInit {
  private readonly logger = new Logger(GoogleCalendarService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    if (!this.isConfigured()) {
      this.logger.warn(
        'Google Calendar sync belum aktif. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, dan GOOGLE_REDIRECT_URI.',
      );
    }
  }

  getAuthUrl(userId?: string): string {
    const parsedUserId = this.parseUserId(userId);
    return this.createOAuthClient().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: CALENDAR_SCOPES,
      state: parsedUserId.toString(),
    });
  }

  telegramDeepLink(): string {
    const username = this.config.get<string>('TELEGRAM_BOT_USERNAME');
    return username ? `https://t.me/${username}` : 'https://t.me/';
  }

  async handleOAuthCallback(code?: string, state?: string): Promise<void> {
    if (!code) throw new BadRequestException('Kode OAuth tidak ditemukan.');
    const userId = this.parseUserId(state);
    const oauth = this.createOAuthClient();
    const { tokens } = await oauth.getToken(code);
    oauth.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth });
    const profile = await oauth2.userinfo.get();
    await this.upsertGoogleAccount(userId, tokens, {
      googleUserId: profile.data.id ?? undefined,
      email: profile.data.email ?? undefined,
    });
    await this.enqueuePollingSync(userId);
    await this.notifyTelegram(
      userId,
      'Google Calendar sudah tersambung. Aku akan sinkronisasi task lewat polling berkala.',
    );
  }

  async enqueueTaskUpsert(task: LinkedTask): Promise<void> {
    if (!(await this.hasLinkedAccount(task.userId))) return;
    await this.prisma.googleSyncJob.create({
      data: {
        userId: task.userId,
        taskId: task.id,
        operation: 'UPSERT_EVENT',
      },
    });
  }

  async enqueueTaskDelete(input: {
    userId: bigint;
    taskId: string;
    googleEventId?: string | null;
    googleCalendarId?: string | null;
  }): Promise<void> {
    if (!input.googleEventId || !(await this.hasLinkedAccount(input.userId))) {
      return;
    }
    await this.prisma.googleSyncJob.create({
      data: {
        userId: input.userId,
        taskId: input.taskId,
        operation: 'DELETE_EVENT',
        payload: {
          googleEventId: input.googleEventId,
          googleCalendarId: input.googleCalendarId ?? 'primary',
        },
      },
    });
  }

  async enqueuePollingSync(userId: bigint): Promise<void> {
    await this.prisma.googleSyncJob.create({
      data: { userId, operation: 'POLL_EVENTS' },
    });
  }

  async upsertEvent(taskId: string): Promise<void> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: this.taskSelect(),
    });
    if (!task) return;
    const account = await this.activeAccount(task.userId);
    if (!account) return;

    const calendar = await this.calendarClient(account);
    const calendarId = task.googleCalendarId ?? account.calendarId;
    const requestBody = this.taskToEvent(task);
    let event: calendar_v3.Schema$Event;

    if (task.googleEventId) {
      try {
        const response = await this.withGoogleRetry(() =>
          calendar.events.patch({
            calendarId,
            eventId: task.googleEventId!,
            requestBody,
          }),
        );
        event = response.data;
      } catch (error) {
        if (!this.isNotFound(error)) throw error;
        const response = await this.withGoogleRetry(() =>
          calendar.events.insert({ calendarId, requestBody }),
        );
        event = response.data;
      }
    } else {
      const response = await this.withGoogleRetry(() =>
        calendar.events.insert({ calendarId, requestBody }),
      );
      event = response.data;
    }

    await this.prisma.task.update({
      where: { id: task.id },
      data: {
        googleCalendarId: calendarId,
        googleEventId: event.id ?? task.googleEventId,
        googleEventUpdatedAt: event.updated ? new Date(event.updated) : null,
        lastSyncedToGoogleAt: new Date(),
      },
    });
  }

  async deleteEvent(input: {
    userId: bigint;
    googleEventId?: string;
    googleCalendarId?: string;
  }): Promise<void> {
    if (!input.googleEventId) return;
    const account = await this.activeAccount(input.userId);
    if (!account) return;
    const calendar = await this.calendarClient(account);
    await this.withGoogleRetry(() =>
      calendar.events.delete({
        calendarId: input.googleCalendarId ?? account.calendarId,
        eventId: input.googleEventId!,
      }),
    ).catch((error) => {
      if (!this.isNotFound(error)) throw error;
    });
  }

  async incrementalSync(userId: bigint): Promise<void> {
    const account = await this.activeAccount(userId);
    if (!account) return;
    const calendar = await this.calendarClient(account);
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;
    const calendarId = account.calendarId;

    do {
      const response = await this.withGoogleRetry(() =>
        calendar.events.list({
          calendarId,
          syncToken: account.syncToken ?? undefined,
          pageToken,
          singleEvents: true,
          showDeleted: true,
          maxResults: 250,
          timeMin: account.syncToken
            ? undefined
            : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      ).catch(async (error) => {
        if (!this.isGone(error) || !account.syncToken) throw error;
        await this.prisma.googleAccount.update({
          where: { userId },
          data: { syncToken: null },
        });
        return calendar.events.list({
          calendarId,
          singleEvents: true,
          showDeleted: true,
          maxResults: 250,
          timeMin: new Date(
            Date.now() - 30 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        });
      });

      for (const event of response.data.items ?? []) {
        await this.applyInboundEvent(userId, calendarId, event);
      }
      pageToken = response.data.nextPageToken ?? undefined;
      nextSyncToken = response.data.nextSyncToken ?? nextSyncToken;
    } while (pageToken);

    await this.prisma.googleAccount.update({
      where: { userId },
      data: {
        syncToken: nextSyncToken ?? account.syncToken,
        lastPolledAt: new Date(),
      },
    });
  }

  async markRevoked(userId: bigint): Promise<void> {
    await this.prisma.googleAccount.updateMany({
      where: { userId },
      data: { revokedAt: new Date() },
    });
    await this.notifyTelegram(
      userId,
      'Akses Google Calendar perlu disambungkan ulang. Jalankan /connect_gcal lagi ya.',
    );
  }

  async notifyTelegram(userId: bigint, text: string): Promise<void> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token || this.config.get<string>('DISABLE_TELEGRAM') === 'true') {
      return;
    }
    try {
      await new Telegraf(token).telegram.sendMessage(userId.toString(), text);
    } catch (error) {
      this.logger.warn(
        `Gagal mengirim notifikasi Telegram ke ${userId.toString()}: ${this.errorMessage(error)}`,
      );
    }
  }

  async linkedAccounts(take = 100): Promise<Array<{ userId: bigint }>> {
    return this.prisma.googleAccount.findMany({
      where: { refreshToken: { not: null }, revokedAt: null },
      select: { userId: true },
      take,
    });
  }

  asDeletePayload(payload: Prisma.JsonValue): {
    googleEventId?: string;
    googleCalendarId?: string;
  } {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return {};
    }
    return {
      googleEventId:
        typeof payload.googleEventId === 'string'
          ? payload.googleEventId
          : undefined,
      googleCalendarId:
        typeof payload.googleCalendarId === 'string'
          ? payload.googleCalendarId
          : undefined,
    };
  }

  isConfigured(): boolean {
    return Boolean(
      this.config.get<string>('GOOGLE_CLIENT_ID') &&
      this.config.get<string>('GOOGLE_CLIENT_SECRET') &&
      this.config.get<string>('GOOGLE_REDIRECT_URI'),
    );
  }

  isUnauthorized(error: unknown): boolean {
    const status = this.errorStatus(error);
    return status === 401 || status === 403 || this.isInvalidGrant(error);
  }

  errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async applyInboundEvent(
    userId: bigint,
    calendarId: string,
    event: calendar_v3.Schema$Event,
  ): Promise<void> {
    if (!event.id) return;
    const privateProps = event.extendedProperties?.private ?? {};
    const taskId = privateProps.taskId;
    const existingTask = await this.prisma.task.findFirst({
      where: {
        userId,
        OR: [{ googleEventId: event.id }, ...(taskId ? [{ id: taskId }] : [])],
      },
      select: this.taskSelect(),
    });

    if (event.status === 'cancelled') {
      if (existingTask) {
        await this.prisma.task.delete({ where: { id: existingTask.id } });
        await this.notifyTelegram(
          userId,
          `Task "${existingTask.title}" dihapus karena event Google Calendar-nya dihapus.`,
        );
      }
      return;
    }

    const eventUpdatedAt = event.updated ? new Date(event.updated) : null;
    if (
      existingTask?.googleEventUpdatedAt &&
      eventUpdatedAt &&
      existingTask.googleEventUpdatedAt.getTime() === eventUpdatedAt.getTime()
    ) {
      return;
    }

    const deadline = this.eventDeadline(event);
    if (!deadline) return;
    const title = this.cleanEventTitle(event.summary);
    const status = this.eventTaskStatus(event);

    if (existingTask) {
      const materiallyChanged =
        existingTask.title !== title ||
        existingTask.deadline.getTime() !== deadline.getTime() ||
        existingTask.status !== status;
      const task = await this.prisma.task.update({
        where: { id: existingTask.id },
        data: {
          title,
          deadline,
          status,
          completedAt: status === 'COMPLETED' ? new Date() : null,
          googleCalendarId: calendarId,
          googleEventId: event.id,
          googleEventUpdatedAt: eventUpdatedAt,
          lastSyncedFromGoogleAt: new Date(),
        },
        select: this.taskSelect(),
      });
      await this.replaceReminders(task.id, task.deadline, task.status);
      if (materiallyChanged) {
        await this.notifyTelegram(
          userId,
          `Task "${task.title}" diperbarui dari Google Calendar.`,
        );
      }
      return;
    }

    const task = await this.prisma.task.create({
      data: {
        userId,
        title,
        deadline,
        status,
        completedAt: status === 'COMPLETED' ? new Date() : null,
        googleCalendarId: calendarId,
        googleEventId: event.id,
        googleEventUpdatedAt: eventUpdatedAt,
        lastSyncedFromGoogleAt: new Date(),
      },
      select: this.taskSelect(),
    });
    await this.replaceReminders(task.id, task.deadline, task.status);
    await this.notifyTelegram(
      userId,
      `Task baru "${task.title}" ditambahkan dari Google Calendar.`,
    );
  }

  private async calendarClient(account: GoogleAccount) {
    const oauth = this.createOAuthClient();
    oauth.setCredentials({
      access_token: this.decryptNullable(account.accessToken),
      refresh_token: this.decryptNullable(account.refreshToken),
      expiry_date: account.tokenExpiry?.getTime(),
    });

    if (
      !account.tokenExpiry ||
      account.tokenExpiry.getTime() < Date.now() + 60_000
    ) {
      const token = await oauth.getAccessToken();
      if (token.token) {
        await this.prisma.googleAccount.update({
          where: { userId: account.userId },
          data: {
            accessToken: this.encrypt(token.token),
            tokenExpiry:
              oauth.credentials.expiry_date != null
                ? new Date(oauth.credentials.expiry_date)
                : account.tokenExpiry,
            revokedAt: null,
          },
        });
      }
    }

    oauth.on('tokens', (tokens) => {
      void this.upsertGoogleAccount(account.userId, tokens, {});
    });
    return google.calendar({ version: 'v3', auth: oauth });
  }

  private async activeAccount(userId: bigint): Promise<GoogleAccount | null> {
    const account = await this.prisma.googleAccount.findUnique({
      where: { userId },
    });
    return account?.refreshToken && !account.revokedAt ? account : null;
  }

  private async hasLinkedAccount(userId: bigint): Promise<boolean> {
    return Boolean(await this.activeAccount(userId));
  }

  private createOAuthClient() {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = this.config.get<string>('GOOGLE_CLIENT_SECRET');
    const redirectUri = this.config.get<string>('GOOGLE_REDIRECT_URI');
    if (!clientId || !clientSecret || !redirectUri) {
      throw new BadRequestException('Konfigurasi Google OAuth belum lengkap.');
    }
    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  private async upsertGoogleAccount(
    userId: bigint,
    tokens: OAuthTokens,
    profile: { googleUserId?: string; email?: string },
  ): Promise<void> {
    await this.prisma.googleAccount.upsert({
      where: { userId },
      create: {
        userId,
        googleUserId: profile.googleUserId,
        email: profile.email,
        accessToken: this.encryptNullable(tokens.access_token),
        refreshToken: this.encryptNullable(tokens.refresh_token),
        tokenExpiry:
          tokens.expiry_date != null ? new Date(tokens.expiry_date) : null,
        scopes: tokens.scope,
        revokedAt: null,
      },
      update: {
        googleUserId: profile.googleUserId,
        email: profile.email,
        accessToken:
          tokens.access_token != null
            ? this.encrypt(tokens.access_token)
            : undefined,
        refreshToken:
          tokens.refresh_token != null
            ? this.encrypt(tokens.refresh_token)
            : undefined,
        tokenExpiry:
          tokens.expiry_date != null ? new Date(tokens.expiry_date) : undefined,
        scopes: tokens.scope ?? undefined,
        revokedAt: null,
      },
    });
  }

  private taskToEvent(task: LinkedTask): calendar_v3.Schema$Event {
    const end = new Date(task.deadline.getTime() + 30 * 60 * 1000);
    const done = task.status === 'COMPLETED';
    return {
      summary: `${done ? '[DONE] ' : ''}${task.title}`,
      description: [
        'Synced from ingetinnia Telegram Task Manager Bot.',
        `Task ID: ${task.id}`,
        `Status: ${task.status}`,
      ].join('\n'),
      start: {
        dateTime: task.deadline.toISOString(),
        timeZone: 'Asia/Jakarta',
      },
      end: { dateTime: end.toISOString(), timeZone: 'Asia/Jakarta' },
      transparency: done ? 'transparent' : 'opaque',
      extendedProperties: {
        private: {
          source: PRIVATE_SYNC_SOURCE,
          taskId: task.id,
          userId: task.userId.toString(),
          taskStatus: task.status,
          taskUpdatedAt: task.updatedAt.toISOString(),
        },
      },
    };
  }

  private eventDeadline(event: calendar_v3.Schema$Event): Date | undefined {
    const value = event.start?.dateTime ?? event.start?.date;
    if (!value) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  private eventTaskStatus(event: calendar_v3.Schema$Event): TaskStatus {
    const status = event.extendedProperties?.private?.taskStatus;
    if (status === 'COMPLETED' || event.summary?.startsWith('[DONE]')) {
      return 'COMPLETED';
    }
    if (status === 'OVERDUE') return 'OVERDUE';
    return event.start?.dateTime &&
      new Date(event.start.dateTime).getTime() <= Date.now()
      ? 'OVERDUE'
      : 'PENDING';
  }

  private cleanEventTitle(summary?: string | null): string {
    const title = summary?.replace(/^\[DONE\]\s*/i, '').trim();
    return title || 'Untitled Google Calendar event';
  }

  private async replaceReminders(
    taskId: string,
    deadline: Date,
    status: TaskStatus,
  ): Promise<void> {
    await this.prisma.reminder.deleteMany({
      where: { taskId, status: 'PENDING' },
    });
    if (status === 'COMPLETED') return;

    const now = Date.now();
    const candidates: Date[] = [];
    const remaining = deadline.getTime() - now;
    if (remaining > 24 * 60 * 60 * 1000) {
      const firstReminder = new Date(now + WIB_OFFSET_MS);
      firstReminder.setUTCHours(2, 0, 0, 0);
      if (firstReminder.getTime() <= now + WIB_OFFSET_MS) {
        firstReminder.setUTCDate(firstReminder.getUTCDate() + 1);
      }
      for (let day = 0; day <= 365; day += 1) {
        const localReminder = new Date(firstReminder);
        localReminder.setUTCDate(localReminder.getUTCDate() + day);
        const utcReminder = new Date(localReminder.getTime() - WIB_OFFSET_MS);
        if (utcReminder < deadline) candidates.push(utcReminder);
        else break;
      }
    } else {
      for (const hours of [6, 3, 1]) {
        const reminder = new Date(deadline.getTime() - hours * 60 * 60 * 1000);
        if (reminder.getTime() > now) candidates.push(reminder);
      }
    }

    const tenMinuteReminder = new Date(deadline.getTime() - 10 * 60 * 1000);
    if (tenMinuteReminder.getTime() > now) candidates.push(tenMinuteReminder);
    candidates.push(deadline);

    await this.prisma.reminder.createMany({
      data: candidates.map((scheduledAt) => ({
        taskId,
        reminderType:
          scheduledAt.getTime() === deadline.getTime()
            ? 'OVERDUE'
            : scheduledAt.getTime() === tenMinuteReminder.getTime()
              ? 'TEN_MINUTES'
              : remaining > 24 * 60 * 60 * 1000
                ? 'DAILY'
                : 'NEAR_DEADLINE',
        scheduledAt,
      })),
      skipDuplicates: true,
    });
  }

  private async withGoogleRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!this.isRetryable(error) || attempt === 2) break;
        await new Promise((resolve) =>
          setTimeout(resolve, 250 * 2 ** attempt + Math.random() * 100),
        );
      }
    }
    throw lastError;
  }

  private encryptNullable(value?: string | null): string | null {
    return value ? this.encrypt(value) : null;
  }

  private decryptNullable(value?: string | null): string | undefined {
    return value ? this.decrypt(value) : undefined;
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    const encrypted = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    return `v1:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      'base64',
    )}`;
  }

  private decrypt(value: string): string {
    if (!value.startsWith('v1:')) return value;
    const payload = Buffer.from(value.slice(3), 'base64');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey(),
      payload.subarray(0, 12),
    );
    decipher.setAuthTag(payload.subarray(12, 28));
    return Buffer.concat([
      decipher.update(payload.subarray(28)),
      decipher.final(),
    ]).toString('utf8');
  }

  private encryptionKey(): Buffer {
    const configured =
      this.config.get<string>('GOOGLE_TOKEN_ENCRYPTION_KEY') ??
      this.config.get<string>('GOOGLE_CLIENT_SECRET') ??
      this.config.get<string>('DATABASE_URL') ??
      'ingetinnia-local-development-key';
    return createHash('sha256').update(configured).digest();
  }

  private parseUserId(value?: string): bigint {
    if (!value) throw new BadRequestException('userId wajib diisi.');
    try {
      return BigInt(value);
    } catch {
      throw new BadRequestException('userId harus berupa angka.');
    }
  }

  private taskSelect() {
    return {
      id: true,
      userId: true,
      title: true,
      deadline: true,
      status: true,
      googleCalendarId: true,
      googleEventId: true,
      googleEventUpdatedAt: true,
      updatedAt: true,
    } satisfies Prisma.TaskSelect;
  }

  private isRetryable(error: unknown): boolean {
    const status = this.errorStatus(error);
    return (
      status === 429 ||
      status === 500 ||
      status === 502 ||
      status === 503 ||
      status === 504
    );
  }

  private isNotFound(error: unknown): boolean {
    const status = this.errorStatus(error);
    return status === 404 || status === 410;
  }

  private isGone(error: unknown): boolean {
    return this.errorStatus(error) === 410;
  }

  private isInvalidGrant(error: unknown): boolean {
    return this.errorMessage(error).toLowerCase().includes('invalid_grant');
  }

  private errorStatus(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const candidate = error as {
      code?: unknown;
      status?: unknown;
      response?: { status?: unknown };
    };
    if (typeof candidate.code === 'number') return candidate.code;
    if (typeof candidate.status === 'number') return candidate.status;
    if (typeof candidate.response?.status === 'number') {
      return candidate.response.status;
    }
    return undefined;
  }
}
