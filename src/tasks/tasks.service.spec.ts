import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { TasksService } from './tasks.service.js';

describe('TasksService', () => {
  const task = {
    id: 'task-1',
    userId: 1n,
    title: 'Belajar Prisma',
    deadline: new Date('2099-10-10T16:59:00.000Z'),
    status: 'PENDING',
    createdAt: new Date(),
    completedAt: null,
    updatedAt: new Date(),
  };

  const prisma = {
    task: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    reminder: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
      updateMany: vi.fn(),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.task.create.mockResolvedValue(task);
    prisma.task.findFirst.mockResolvedValue(task);
    prisma.task.update.mockResolvedValue({ ...task, status: 'COMPLETED' });
    prisma.task.updateMany.mockResolvedValue({ count: 0 });
    prisma.task.deleteMany.mockResolvedValue({ count: 2 });
    prisma.reminder.deleteMany.mockResolvedValue({ count: 0 });
    prisma.reminder.createMany.mockResolvedValue({ count: 1 });
    prisma.reminder.updateMany.mockResolvedValue({ count: 1 });
  });

  it('rejects deadlines in the past', async () => {
    const service = new TasksService(prisma as never);

    await expect(
      service.create({
        title: 'Task lama',
        deadline: '2020-01-01T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.task.create).not.toHaveBeenCalled();
  });

  it('creates a task and schedules future reminders', async () => {
    const service = new TasksService(prisma as never);

    const result = await service.create({
      title: '  Belajar Prisma  ',
      deadline: '2099-10-10T16:59:00.000Z',
    });

    expect(prisma.task.create).toHaveBeenCalledWith({
      data: {
        title: 'Belajar Prisma',
        deadline: new Date('2099-10-10T16:59:00.000Z'),
        userId: 1n,
      },
      select: expect.any(Object),
    });
    expect(prisma.reminder.createMany).toHaveBeenCalled();
    expect(result.userId).toBe('1');
  });

  it('completes a task and cancels its pending reminders', async () => {
    const service = new TasksService(prisma as never);

    await service.complete('task-1', 1n);

    expect(prisma.task.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: { status: 'COMPLETED', completedAt: expect.any(Date) },
      select: expect.any(Object),
    });
    expect(prisma.reminder.updateMany).toHaveBeenCalledWith({
      where: { taskId: 'task-1', status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
  });

  it('updates only a task owned by the user', async () => {
    const service = new TasksService(prisma as never);
    prisma.task.update.mockResolvedValue({ ...task, title: 'Belajar NestJS' });

    const result = await service.updateTask(1n, 'task-1', {
      title: '  Belajar NestJS  ',
    });

    expect(prisma.task.findFirst).toHaveBeenCalledWith({
      where: { id: 'task-1', userId: 1n },
      select: expect.any(Object),
    });
    expect(prisma.task.update).toHaveBeenCalledWith({
      where: { id: 'task-1', userId: 1n },
      data: { title: 'Belajar NestJS' },
      select: expect.any(Object),
    });
    expect(result.title).toBe('Belajar NestJS');
  });

  it('bulk deletes tasks with user isolation and no per-task loop', async () => {
    const service = new TasksService(prisma as never);

    const result = await service.bulkDelete(1n, ['task-1', 'task-2', 'task-1']);

    expect(prisma.task.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.task.deleteMany).toHaveBeenCalledWith({
      where: { userId: 1n, id: { in: ['task-1', 'task-2'] } },
    });
    expect(result).toEqual({ deletedCount: 2, requestedCount: 2 });
  });
});
