import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Groq from 'groq-sdk';
import {
  NlpChatterResult,
  NlpTaskResponse,
  NlpTaskResult,
} from './nlp.types.js';

const MODEL = 'llama-3.1-8b-instant';

@Injectable()
export class NlpService {
  private readonly logger = new Logger(NlpService.name);
  private readonly client?: Groq;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('GROQ_API_KEY');
    if (apiKey) this.client = new Groq({ apiKey });
  }

  async parseTask(
    message: string,
    referenceDate: string,
  ): Promise<NlpTaskResult | NlpChatterResult> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'NLP belum tersedia karena GROQ_API_KEY belum diatur.',
      );
    }

    const completion = await this.client.chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'You extract task reminders from mixed Indonesian and English text.',
            'Return only a JSON object, never markdown.',
            'If the user is not asking to create a reminder/task, return exactly {"isTask":false}.',
            'For a task, return {"isTask":true,"title":"...","dueDate":"..."}.',
            'dueDate must be an ISO-8601 timestamp in UTC and must be in the future.',
            'Resolve relative dates and times using the supplied reference datetime in Asia/Jakarta.',
            'Keep the title concise and preserve the task meaning without the reminder instruction.',
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify({ message, referenceDate }),
        },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error('Groq mengembalikan respons kosong.');

    let parsed: NlpTaskResponse;
    try {
      parsed = JSON.parse(content) as NlpTaskResponse;
    } catch (error) {
      this.logger.error('Respons Groq bukan JSON yang valid.', error);
      throw new Error('Respons NLP tidak valid.');
    }

    if (parsed.isTask === false) return { isTask: false };
    if (
      parsed.isTask !== true ||
      typeof parsed.title !== 'string' ||
      !parsed.title.trim() ||
      typeof parsed.dueDate !== 'string' ||
      Number.isNaN(new Date(parsed.dueDate).getTime()) ||
      new Date(parsed.dueDate).getTime() <= Date.now()
    ) {
      throw new Error('Respons NLP tidak berisi task yang valid.');
    }

    return {
      isTask: true,
      title: parsed.title.trim(),
      dueDate: new Date(parsed.dueDate).toISOString(),
    };
  }
}
