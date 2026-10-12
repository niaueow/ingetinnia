import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GoogleCalendarModule } from '../google-calendar/google-calendar.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { TelegramService } from './telegram.service.js';

@Module({
  imports: [ConfigModule, GoogleCalendarModule, TasksModule],
  providers: [TelegramService],
})
export class TelegramModule {}
