import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NlpService } from './nlp.service.js';

@Module({
  imports: [ConfigModule],
  providers: [NlpService],
  exports: [NlpService],
})
export class NlpModule {}
