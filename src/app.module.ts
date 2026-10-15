import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { GoogleCalendarModule } from './google-calendar/google-calendar.module.js';
import { NlpModule } from './nlp/nlp.module.js';
import { PrismaModule } from './prisma.module.js';
import { TasksModule } from './tasks/tasks.module.js';
import { TelegramModule } from './telegram/telegram.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../.env'] }),
    ScheduleModule.forRoot(),
    PrismaModule,
    GoogleCalendarModule,
    NlpModule,
    TasksModule,
    TelegramModule,
  ],
})
export class AppModule {}
