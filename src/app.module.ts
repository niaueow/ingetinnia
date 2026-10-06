import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { TasksModule } from './tasks/tasks.module.js';
import { TelegramModule } from './telegram/telegram.module.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../.env'] }), TasksModule, TelegramModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
