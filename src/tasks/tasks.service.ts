import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service.js';
import { CreateTaskDto, UpdateDeadlineDto } from './task.dto.js';

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const DEFAULT_USER_ID = 1n;
const TASK_SELECT = {
  id: true,
  userId: true,
  title: true,
  deadline: true,
  status: true,
  createdAt: true,
  completedAt: true,
  updatedAt: true,
} satisfies Prisma.TaskSelect;
const PENDING_REMINDER_SELECT = {
  id: true,
  taskId: true,
  reminderType: true,
  scheduledAt: true,
  sentAt: true,
  status: true,
} satisfies Prisma.ReminderSelect;

@Injectable()
export class TasksService {
  constructor(private readonly prisma: PrismaService) {}

  parseUserId(value?: string): bigint {
    if (!value) return DEFAULT_USER_ID;
    try {
      return BigInt(value);
    } catch {
      throw new BadRequestException('userId harus berupa angka.');
    }
  }

  async create(input: CreateTaskDto) {
    const title = input.title?.trim();
    if (!title) throw new BadRequestException('Judul task wajib diisi.');

    const deadline = this.parseFutureDeadline(input.deadline);
    const userId = this.parseUserId(input.userId?.toString());
    const task = await this.prisma.task.create({
      data: { title, deadline, userId },
      select: TASK_SELECT,
    });
    await this.replaceReminders(task.id, deadline);
    return this.serializeTask(task);
  }

  async listActive(userId: bigint) {
    await this.markOverdue(userId);
    const tasks = await this.prisma.task.findMany({
      where: { userId, status: { in: ['PENDING', 'OVERDUE'] } },
      orderBy: { deadline: 'asc' },
      select: {
        ...TASK_SELECT,
        reminders: {
          where: { status: 'PENDING' },
          orderBy: { scheduledAt: 'asc' },
          select: PENDING_REMINDER_SELECT,
        },
      },
    });
    return tasks.map((task) => this.serializeTask(task));
  }

  async today(userId: bigint) {
    await this.markOverdue(userId);
    const { start, end } = this.wibDayBounds(new Date());
    const tasks = await this.prisma.task.findMany({
      where: {
        userId,
        status: { in: ['PENDING', 'OVERDUE'] },
        deadline: { gte: start, lt: end },
      },
      orderBy: { deadline: 'asc' },
      select: TASK_SELECT,
    });
    return tasks.map((task) => this.serializeTask(task));
  }

  async overdueToday(userId: bigint) {
    await this.markOverdue(userId);
    const { start, end } = this.wibDayBounds(new Date());
    const tasks = await this.prisma.task.findMany({
      where: {
        userId,
        status: 'OVERDUE',
        deadline: { gte: start, lt: end },
      },
      orderBy: { deadline: 'asc' },
      select: TASK_SELECT,
    });
    return tasks.map((task) => this.serializeTask(task));
  }

  async upcoming(userId: bigint) {
    await this.markOverdue(userId);
    const { end } = this.wibDayBounds(new Date());
    const tasks = await this.prisma.task.findMany({
      where: {
        userId,
        status: 'PENDING',
        deadline: { gte: end },
      },
      orderBy: { deadline: 'asc' },
      select: TASK_SELECT,
    });
    return tasks.map((task) => this.serializeTask(task));
  }

  async complete(id: string, userId: bigint) {
    await this.findOwnedTask(id, userId);
    const task = await this.prisma.task.update({
      where: { id },
      data: { status: 'COMPLETED', completedAt: new Date() },
      select: TASK_SELECT,
    });
    await this.prisma.reminder.updateMany({
      where: { taskId: id, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
    return this.serializeTask(task);
  }

  async completeByTitle(title: string, userId: bigint) {
    const normalizedTitle = title.trim();
    const task = await this.prisma.task.findFirst({
      where: {
        userId,
        status: { in: ['PENDING', 'OVERDUE'] },
        title: { equals: normalizedTitle, mode: 'insensitive' },
      },
      orderBy: { deadline: 'asc' },
      select: { id: true },
    });
    if (!task)
      throw new NotFoundException('Task dengan judul itu tidak ditemukan.');
    return this.complete(task.id, userId);
  }

  async updateDeadline(id: string, input: UpdateDeadlineDto, userId: bigint) {
    await this.findOwnedTask(id, userId);
    const deadline = this.parseFutureDeadline(input.deadline);
    const task = await this.prisma.task.update({
      where: { id },
      data: { deadline, status: 'PENDING', completedAt: null },
      select: TASK_SELECT,
    });
    await this.replaceReminders(id, deadline);
    return this.serializeTask(task);
  }

  async remove(id: string, userId: bigint) {
    await this.findOwnedTask(id, userId);
    await this.prisma.task.delete({ where: { id } });
    return { message: 'Oke, task-nya udah dihapus.' };
  }

  async snooze(id: string, minutes: number, userId: bigint) {
    const task = await this.findOwnedTask(id, userId);
    if (!Number.isInteger(minutes) || minutes <= 0) {
      throw new BadRequestException('Durasi snooze tidak valid.');
    }
    const scheduledAt = new Date(Date.now() + minutes * 60 * 1000);
    await this.prisma.reminder.create({
      data: {
        taskId: task.id,
        reminderType: 'SNOOZE',
        scheduledAt,
      },
    });
    return { scheduledAt };
  }

  private async findOwnedTask(id: string, userId: bigint) {
    const task = await this.prisma.task.findFirst({
      where: { id, userId },
      select: TASK_SELECT,
    });
    if (!task) throw new NotFoundException('Task tidak ditemukan.');
    return task;
  }

  private serializeTask<T extends { userId: bigint }>(task: T) {
    return { ...task, userId: task.userId.toString() };
  }

  private parseFutureDeadline(value?: string): Date {
    if (!value) throw new BadRequestException('Deadline wajib diisi.');
    const deadline = new Date(value);
    if (Number.isNaN(deadline.getTime()))
      throw new BadRequestException('Format deadline tidak valid.');
    if (deadline.getTime() <= Date.now())
      throw new BadRequestException('Deadline harus berada di masa depan.');
    return deadline;
  }

  private async markOverdue(userId: bigint): Promise<void> {
    await this.prisma.task.updateMany({
      where: { userId, status: 'PENDING', deadline: { lte: new Date() } },
      data: { status: 'OVERDUE' },
    });
  }

  private async replaceReminders(
    taskId: string,
    deadline: Date,
  ): Promise<void> {
    await this.prisma.reminder.deleteMany({
      where: { taskId, status: 'PENDING' },
    });
    const now = Date.now();
    const candidates: Date[] = [];
    const remaining = deadline.getTime() - now;

    if (remaining > 24 * 60 * 60 * 1000) {
      const firstReminder = new Date(now + WIB_OFFSET_MS);
      firstReminder.setUTCHours(2, 0, 0, 0);
      if (firstReminder.getTime() <= now + WIB_OFFSET_MS)
        firstReminder.setUTCDate(firstReminder.getUTCDate() + 1);
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

    if (candidates.length) {
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
  }

  private wibDayBounds(now: Date): { start: Date; end: Date } {
    const local = new Date(now.getTime() + WIB_OFFSET_MS);
    local.setUTCHours(0, 0, 0, 0);
    const start = new Date(local.getTime() - WIB_OFFSET_MS);
    return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
  }
}
