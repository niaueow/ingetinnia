import { Controller, Get, Query, Redirect } from '@nestjs/common';
import { GoogleCalendarService } from './google-calendar.service.js';

@Controller('google-calendar')
export class GoogleCalendarController {
  constructor(private readonly googleCalendar: GoogleCalendarService) {}

  @Get('auth')
  @Redirect()
  auth(@Query('userId') userId?: string) {
    return { url: this.googleCalendar.getAuthUrl(userId), statusCode: 302 };
  }

  @Get('callback')
  @Redirect()
  async callback(@Query('code') code?: string, @Query('state') state?: string) {
    await this.googleCalendar.handleOAuthCallback(code, state);
    return { url: this.googleCalendar.telegramDeepLink(), statusCode: 302 };
  }
}
