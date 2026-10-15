import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GoogleCalendarModule } from '../google-calendar/google-calendar.module.js';
import { NlpModule } from '../nlp/nlp.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { TelegramService } from './telegram.service.js';

@Module({
  imports: [ConfigModule, GoogleCalendarModule, NlpModule, TasksModule],
  providers: [TelegramService],
})
export class TelegramModule {}
