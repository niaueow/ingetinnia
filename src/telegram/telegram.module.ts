import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TasksModule } from '../tasks/tasks.module.js';
import { TelegramService } from './telegram.service.js';

@Module({
  imports: [ConfigModule, TasksModule],
  providers: [TelegramService],
})
export class TelegramModule {}
