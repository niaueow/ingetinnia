import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma.module.js';
import { GoogleCalendarController } from './google-calendar.controller.js';
import { GoogleCalendarScheduler } from './google-calendar.scheduler.js';
import { GoogleCalendarService } from './google-calendar.service.js';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [GoogleCalendarController],
  providers: [GoogleCalendarService, GoogleCalendarScheduler],
  exports: [GoogleCalendarService],
})
export class GoogleCalendarModule {}
