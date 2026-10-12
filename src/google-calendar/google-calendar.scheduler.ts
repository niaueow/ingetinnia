import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { GoogleSyncJob } from '@prisma/client';
import { PrismaService } from '../prisma.service.js';
import { GoogleCalendarService } from './google-calendar.service.js';

const MAX_ATTEMPTS = 6;

@Injectable()
export class GoogleCalendarScheduler {
  private readonly logger = new Logger(GoogleCalendarScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly googleCalendar: GoogleCalendarService,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async processPendingJobs(): Promise<void> {
    if (!this.googleCalendar.isConfigured()) return;
    const jobs = await this.prisma.googleSyncJob.findMany({
      where: { status: 'PENDING', runAfter: { lte: new Date() } },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });

    for (const job of jobs) {
      const claimed = await this.prisma.googleSyncJob.updateMany({
        where: { id: job.id, status: 'PENDING' },
        data: { status: 'PROCESSING', lockedAt: new Date() },
      });
      if (!claimed.count) continue;
      await this.processJob(job);
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async enqueueIncrementalPolls(): Promise<void> {
    if (!this.googleCalendar.isConfigured()) return;
    const accounts = await this.googleCalendar.linkedAccounts();
    for (const account of accounts) {
      const activeJob = await this.prisma.googleSyncJob.findFirst({
        where: {
          userId: account.userId,
          operation: 'POLL_EVENTS',
          status: { in: ['PENDING', 'PROCESSING'] },
        },
        select: { id: true },
      });
      if (!activeJob)
        await this.googleCalendar.enqueuePollingSync(account.userId);
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async recoverStaleJobs(): Promise<void> {
    await this.prisma.googleSyncJob.updateMany({
      where: {
        status: 'PROCESSING',
        lockedAt: { lt: new Date(Date.now() - 5 * 60 * 1000) },
      },
      data: { status: 'PENDING', lockedAt: null },
    });
  }

  private async processJob(job: GoogleSyncJob): Promise<void> {
    try {
      if (job.operation === 'UPSERT_EVENT') {
        if (job.taskId) await this.googleCalendar.upsertEvent(job.taskId);
      } else if (job.operation === 'DELETE_EVENT') {
        const payload = this.googleCalendar.asDeletePayload(job.payload);
        await this.googleCalendar.deleteEvent({
          userId: job.userId,
          googleEventId: payload.googleEventId,
          googleCalendarId: payload.googleCalendarId,
        });
      } else {
        await this.googleCalendar.incrementalSync(job.userId);
      }

      await this.prisma.googleSyncJob.update({
        where: { id: job.id },
        data: { status: 'COMPLETED', lockedAt: null, lastError: null },
      });
    } catch (error) {
      await this.failOrRetry(job, error);
    }
  }

  private async failOrRetry(job: GoogleSyncJob, error: unknown): Promise<void> {
    if (this.googleCalendar.isUnauthorized(error)) {
      await this.googleCalendar.markRevoked(job.userId);
    }

    const attempts = job.attempts + 1;
    const permanent =
      this.googleCalendar.isUnauthorized(error) || attempts >= MAX_ATTEMPTS;
    const delaySeconds = Math.min(15 * 2 ** Math.max(0, attempts - 1), 900);

    await this.prisma.googleSyncJob.update({
      where: { id: job.id },
      data: {
        status: permanent ? 'FAILED' : 'PENDING',
        attempts,
        lockedAt: null,
        runAfter: permanent
          ? new Date()
          : new Date(Date.now() + delaySeconds * 1000),
        lastError: this.googleCalendar.errorMessage(error).slice(0, 2000),
      },
    });

    if (permanent) {
      this.logger.error(`Google sync job ${job.id} gagal permanen`, error);
    }
  }
}
