import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { TasksController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';

@Module({
  controllers: [TasksController],
  providers: [PrismaService, TasksService],
  exports: [TasksService],
})
export class TasksModule {}
