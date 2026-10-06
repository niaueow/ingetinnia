import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../prisma.service.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { TelegramService } from './telegram.service.js';

@Module({
  imports: [ConfigModule, TasksModule],
  providers: [PrismaService, TelegramService],
})
export class TelegramModule {}
