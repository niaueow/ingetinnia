import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { Context, Markup, Telegraf } from 'telegraf';

const DUE_REMINDER_SELECT = {
  id: true,
  reminderType: true,
  scheduledAt: true,
  task: {
    select: {
      id: true,
      userId: true,
      title: true,
      deadline: true,
      status: true,
    },
  },
};

type AddState = {
  step: 'title' | 'date' | 'hour' | 'minute';
  title?: string;
  date?: string;
  hour?: number;
};
type BotContext = Context & { chat?: { id: number }; from?: { id: number } };

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private readonly states = new Map<number, AddState>();
  private bot?: Telegraf<BotContext>;
  private reminderTimer?: NodeJS.Timeout;
  private reminderWorkerRunning = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
  ) {}

  async onModuleInit(): Promise<void> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token || this.config.get<string>('DISABLE_TELEGRAM') === 'true') {
      this.logger.warn(
        'TELEGRAM_BOT_TOKEN belum diatur; Telegram bot tidak dijalankan.',
      );
      return;
    }

    this.bot = new Telegraf<BotContext>(token);
    this.registerHandlers(this.bot);
    void this.startPolling();
  }

  private async startPolling(): Promise<void> {
    if (!this.bot) return;
    this.reminderTimer = setInterval(
      () => void this.sendDueReminders(),
      30_000,
    );
    void this.sendDueReminders();
    try {
      await this.bot.launch();
      this.logger.log('Telegram bot aktif dengan long polling.');
    } catch (error) {
      this.logger.error(
        'Telegram bot gagal terhubung. Periksa token dan akses jaringan.',
        error,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.reminderTimer) clearInterval(this.reminderTimer);
    this.reminderTimer = undefined;
    this.bot?.stop('shutdown');
    this.bot = undefined;
    this.states.clear();
  }

  private registerHandlers(bot: Telegraf<BotContext>): void {
    bot.start((ctx) => this.sendMenu(ctx));
    bot.help((ctx) => ctx.reply(this.helpMessage()));
    bot.command('add', (ctx) => this.beginAdd(ctx));
    bot.command('tasks', (ctx) => this.sendTasks(ctx));
    bot.command('today', (ctx) => this.sendToday(ctx));
    bot.command('overdue', (ctx) => this.sendOverdue(ctx));
    bot.command('done', (ctx) => this.completeFromCommand(ctx));

    bot.on('callback_query', async (ctx) => {
      const callback = ctx.callbackQuery;
      if (!('data' in callback)) return;
      await ctx.answerCbQuery();
      await this.handleCallback(ctx, callback.data);
    });

    bot.on('text', (ctx) => this.handleText(ctx));
  }

  private async sendMenu(ctx: BotContext): Promise<void> {
    await ctx.reply(
      'Hi nia!\nmau nambah task apa?',
      Markup.keyboard([
        ['tambah task baruw'],
        ['liat task', "today's task"],
      ]).resize(),
    );
  }

  private helpMessage(): string {
    return [
      '/start - mulai ingetinnia',
      '/add - tambah task',
      '/tasks - lihat task aktif',
      '/today - task hari ini',
      '/overdue - task overdue hari ini',
      '/done <judul> - selesaikan task',
      '',
      'Deadline dipilih lewat kalender WIB setelah judul task diisi.',
    ].join('\n');
  }

  private async beginAdd(ctx: BotContext): Promise<void> {
    const chatId = this.chatId(ctx);
    if (!chatId) return;
    const message = ctx.message;
    const commandText =
      message && 'text' in message
        ? message.text.replace(/^\/add\s*/i, '').trim()
        : '';
    if (commandText) {
      const [title, deadline] = commandText
        .split('|')
        .map((value) => value.trim());
      if (title && deadline) return this.createTask(ctx, title, deadline);
      this.states.set(chatId, { step: 'date', title: commandText });
      await this.sendCalendar(ctx);
      return;
    }
    this.states.set(chatId, { step: 'title' });
    await ctx.reply('Mau nambah task apa nih?');
  }

  private async handleText(ctx: BotContext): Promise<void> {
    const chatId = this.chatId(ctx);
    const message = ctx.message;
    if (!chatId || !message || !('text' in message)) return;
    const text = message.text.trim();
    if (text === 'tambah task baruw') {
      this.states.set(chatId, { step: 'title' });
      return void ctx.reply('Mau nambahin task apa nih?');
    }
    if (text === 'liat task') return this.sendTasks(ctx);
    if (text === "today's task") return this.sendToday(ctx);
    if (text === 'overdue hari ini') return this.sendOverdue(ctx);

    const state = this.states.get(chatId);
    if (!state) return;
    if (state.step === 'title') {
      this.states.set(chatId, { step: 'date', title: text });
      return this.sendCalendar(ctx);
    }
  }

  private async createTask(
    ctx: BotContext,
    title: string,
    deadlineInput: string,
  ): Promise<void> {
    const chatId = this.chatId(ctx);
    if (!chatId) return;
    try {
      const task = await this.tasks.create({
        title,
        deadline: this.parseWibDate(deadlineInput),
        userId: chatId,
      });
      this.states.delete(chatId);
      await ctx.reply(
        `okeh, task-nya don dicatet :D\n📝 ${task.title}\n📅 ${this.formatDate(task.deadline)}`,
      );
    } catch (error) {
      await ctx.reply(
        error instanceof Error
          ? error.message
          : 'Deadline-nya belum bisa dipahami.',
      );
    }
  }

  private async sendTasks(ctx: BotContext): Promise<void> {
    const chatId = this.chatId(ctx);
    if (!chatId) return;
    const tasks = await this.tasks.listActive(BigInt(chatId));
    if (!tasks.length) return void ctx.reply('Belum ada task yang aktif.');
    await ctx.reply(
      `Task kamu yang belum selesai:\n\n${tasks.map((task, index) => `${index + 1}. ${task.title}\n📅 ${this.formatDate(task.deadline)}`).join('\n\n')}`,
      this.taskKeyboard(tasks),
    );
  }

  private async sendToday(ctx: BotContext): Promise<void> {
    const chatId = this.chatId(ctx);
    if (!chatId) return;
    const tasks = await this.tasks.today(BigInt(chatId));
    if (!tasks.length)
      return void ctx.reply(
        'Hari ini aman!\nNggak ada task yang deadline hari ini yey!',
      );
    await ctx.reply(
      `Task buat today:\n\n${tasks.map((task) => `📝 ${task.title}\n⏰ ${this.formatDate(task.deadline)}`).join('\n\n')}`,
      this.taskKeyboard(tasks),
    );
  }

  private async sendOverdue(ctx: BotContext): Promise<void> {
    const chatId = this.chatId(ctx);
    if (!chatId) return;
    const tasks = await this.tasks.overdueToday(BigInt(chatId));
    if (!tasks.length)
      return void ctx.reply('Hari ini belum ada task yang overdue.');
    await ctx.reply(
      `Task overdue hari ini:\n\n${tasks.map((task) => `⚠️ ${task.title}\nDeadline: ${this.formatDate(task.deadline)}`).join('\n\n')}`,
      this.taskKeyboard(tasks),
    );
  }

  private async completeFromCommand(ctx: BotContext): Promise<void> {
    const chatId = this.chatId(ctx);
    const message = ctx.message;
    if (!chatId || !message || !('text' in message)) return;
    const title = message.text.replace(/^\/done\s*/i, '').trim();
    if (!title) return void ctx.reply('Pakai: /done <judul task>');
    try {
      await this.tasks.completeByTitle(title, BigInt(chatId));
      await ctx.reply('Yay, satu task kelar! 🎉');
    } catch (error) {
      await ctx.reply(
        error instanceof Error
          ? error.message
          : 'Task belum bisa diselesaikan.',
      );
    }
  }

  private async handleCallback(ctx: BotContext, data: string): Promise<void> {
    const chatId = this.chatId(ctx);
    if (!chatId) return;
    const [action, value, taskId] = data.split(':');
    try {
      if (action === 'noop') {
        return;
      } else if (action === 'date') {
        const state = this.states.get(chatId);
        if (!state?.title) return;
        this.states.set(chatId, { ...state, step: 'hour', date: value });
        await ctx.editMessageText(
          `Tanggal ${value} dipilih. Jam berapa nih?`,
          this.hourKeyboard(value),
        );
      } else if (action === 'hour') {
        const state = this.states.get(chatId);
        if (!state?.title || !state.date) return;
        this.states.set(chatId, {
          ...state,
          step: 'minute',
          hour: Number(value),
        });
        await ctx.editMessageText(
          `Jam ${value}:00 dipilih. Menitnya?`,
          this.minuteKeyboard(state.date, Number(value)),
        );
      } else if (action === 'minute') {
        const state = this.states.get(chatId);
        if (!state?.title || !state.date || state.hour === undefined) return;
        await this.createTask(
          ctx,
          state.title,
          `${state.date}T${String(state.hour).padStart(2, '0')}:${value}`,
        );
      } else if (action === 'calendar') {
        const [year, month] = taskId.split('-').map(Number);
        const offset = value === 'next' ? 1 : -1;
        const date = new Date(Date.UTC(year, month - 1 + offset, 1));
        await ctx.editMessageReplyMarkup(
          this.calendarKeyboard(date.getUTCFullYear(), date.getUTCMonth())
            .reply_markup,
        );
      } else if (action === 'complete') {
        await this.tasks.complete(value, BigInt(chatId));
        await ctx.editMessageText('Yay, satu task kelar! 🎉');
      } else if (action === 'delete') {
        await this.tasks.remove(value, BigInt(chatId));
        await ctx.editMessageText('Oke, task-nya udah dihapus.');
      } else if (action === 'snooze') {
        await this.tasks.snooze(taskId, Number(value), BigInt(chatId));
        await ctx.editMessageText(`Oke, aku ingetin lagi ${value} menit lagi.`);
      } else if (action === 'snooze-menu') {
        await ctx.editMessageReplyMarkup(
          Markup.inlineKeyboard([
            [Markup.button.callback('1 Menit', `snooze:1:${value}`)],
            [Markup.button.callback('30 Menit', `snooze:30:${value}`)],
            [Markup.button.callback('1 Jam', `snooze:60:${value}`)],
            [Markup.button.callback('3 Jam', `snooze:180:${value}`)],
          ]).reply_markup,
        );
      }
    } catch (error) {
      await ctx.reply(
        error instanceof Error ? error.message : 'Aksi belum bisa dijalankan.',
      );
    }
  }

  private taskKeyboard(tasks: Array<{ id: string }>) {
    return Markup.inlineKeyboard(
      tasks.map((task) => [
        Markup.button.callback('✓ Selesai', `complete:${task.id}`),
        Markup.button.callback('Snooze', `snooze-menu:${task.id}`),
        Markup.button.callback('🗑 Hapus', `delete:${task.id}`),
      ]),
    );
  }

  private async sendCalendar(
    ctx: BotContext,
    monthDate = new Date(),
  ): Promise<void> {
    const local = new Date(monthDate.getTime() + 7 * 60 * 60 * 1000);
    await ctx.reply(
      'Deadline-nya kapan nih? Pilih tanggal:',
      this.calendarKeyboard(local.getUTCFullYear(), local.getUTCMonth()),
    );
  }

  private calendarKeyboard(year: number, month: number) {
    const monthLabel = new Intl.DateTimeFormat('id-ID', {
      month: 'long',
      year: 'numeric',
      timeZone: 'Asia/Jakarta',
    }).format(new Date(Date.UTC(year, month, 1)));
    const firstDay = new Date(Date.UTC(year, month, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const today = this.wibNow();
    const todayKey = `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`;
    const rows = [
      [
        Markup.button.callback(
          '‹',
          `calendar:prev:${year}-${String(month + 1).padStart(2, '0')}`,
        ),
        Markup.button.callback(monthLabel, 'noop'),
        Markup.button.callback(
          '›',
          `calendar:next:${year}-${String(month + 1).padStart(2, '0')}`,
        ),
      ],
    ];
    const weekdays = ['Mg', 'Sn', 'Sl', 'Rb', 'Km', 'Jm', 'Sb'];
    rows.push(weekdays.map((day) => Markup.button.callback(day, 'noop')));
    let week = [];
    for (let index = 0; index < firstDay; index += 1)
      week.push(Markup.button.callback(' ', 'noop'));
    for (let day = 1; day <= daysInMonth; day += 1) {
      const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const isPast = dateKey < todayKey;
      week.push(
        Markup.button.callback(
          isPast ? '·' : String(day),
          isPast ? 'noop' : `date:${dateKey}`,
        ),
      );
      if (week.length === 7) {
        rows.push(week);
        week = [];
      }
    }
    if (week.length) {
      while (week.length < 7) week.push(Markup.button.callback(' ', 'noop'));
      rows.push(week);
    }
    return Markup.inlineKeyboard(rows);
  }

  private hourKeyboard(date: string) {
    const now = this.wibNow();
    const isToday =
      date ===
      `${now.year}-${String(now.month).padStart(2, '0')}-${String(now.day).padStart(2, '0')}`;
    const rows = [];
    for (let hour = 0; hour < 24; hour += 4) {
      rows.push(
        Array.from({ length: 4 }, (_, index) => {
          const value = hour + index;
          const isPast = isToday && value < now.hour;
          return Markup.button.callback(
            isPast ? '·' : `${String(value).padStart(2, '0')}:00`,
            isPast ? 'noop' : `hour:${value}`,
          );
        }),
      );
    }
    return Markup.inlineKeyboard(rows);
  }

  private minuteKeyboard(date: string, hour: number) {
    const now = this.wibNow();
    const isCurrentHour =
      date ===
        `${now.year}-${String(now.month).padStart(2, '0')}-${String(now.day).padStart(2, '0')}` &&
      hour === now.hour;
    return Markup.inlineKeyboard(
      [0, 15, 30, 45, 55].map((minute) => {
        const isPast = isCurrentHour && minute <= now.minute;
        return [
          Markup.button.callback(
            isPast ? '·' : `:${String(minute).padStart(2, '0')}`,
            isPast ? 'noop' : `minute:${String(minute).padStart(2, '0')}`,
          ),
        ];
      }),
    );
  }

  private wibNow(): {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
  } {
    const now = new Date(Date.now() + 7 * 60 * 60 * 1000);
    return {
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
      day: now.getUTCDate(),
      hour: now.getUTCHours(),
      minute: now.getUTCMinutes(),
    };
  }

  private async sendDueReminders(): Promise<void> {
    if (!this.bot || this.reminderWorkerRunning) return;
    this.reminderWorkerRunning = true;
    try {
      await this.ensureOverdueReminders();
      const reminders = await this.prisma.reminder.findMany({
        where: { status: 'PENDING', scheduledAt: { lte: new Date() } },
        select: DUE_REMINDER_SELECT,
        orderBy: { scheduledAt: 'asc' },
        take: 50,
      });
      for (const reminder of reminders) {
        if (reminder.task.status === 'COMPLETED') {
          await this.prisma.reminder.update({
            where: { id: reminder.id },
            data: { status: 'CANCELLED' },
          });
          continue;
        }
        try {
          const overdue = reminder.task.deadline.getTime() <= Date.now();
          if (overdue && reminder.task.status === 'PENDING') {
            await this.prisma.task.update({
              where: { id: reminder.task.id },
              data: { status: 'OVERDUE' },
            });
          }
          const text =
            reminder.reminderType === 'TEN_MINUTES'
              ? `⏰ 10 menit lagi deadline-nya cuy!\n📝 ${reminder.task.title}\nDeadline: ${this.formatDate(reminder.task.deadline)}`
              : overdue
                ? `woi, task ini udah lewat deadline :)).\n📝 ${reminder.task.title}\nDeadline: ${this.formatDate(reminder.task.deadline)}`
                : `hey, janlup masih ada task nih!\n📝 ${reminder.task.title}\n📅 Deadline: ${this.formatDate(reminder.task.deadline)}`;
          await this.bot.telegram.sendMessage(
            reminder.task.userId.toString(),
            text,
            this.taskKeyboard([{ id: reminder.task.id }]),
          );
          await this.prisma.reminder.update({
            where: { id: reminder.id },
            data: { status: 'SENT', sentAt: new Date() },
          });
        } catch (error) {
          if (this.isPermanentRecipientError(error)) {
            await this.prisma.reminder.update({
              where: { id: reminder.id },
              data: { status: 'CANCELLED' },
            });
            this.logger.warn(
              `Reminder ${reminder.id} dibatalkan karena chat Telegram ` +
                `${reminder.task.userId.toString()} tidak dapat diakses. ` +
                'Pastikan pengguna sudah mengirim /start ke bot dan task memakai chat ID yang benar.',
            );
          } else {
            this.logger.error(`Gagal mengirim reminder ${reminder.id}`, error);
          }
        }
      }
    } catch (error) {
      this.logger.error('Reminder worker gagal membaca database', error);
    } finally {
      this.reminderWorkerRunning = false;
    }
  }

  private async ensureOverdueReminders(): Promise<void> {
    const tasks = await this.prisma.task.findMany({
      where: { status: 'PENDING', deadline: { lte: new Date() } },
      select: { id: true, deadline: true },
    });
    if (tasks.length) {
      await this.prisma.reminder.createMany({
        data: tasks.map((task) => ({
          taskId: task.id,
          reminderType: 'OVERDUE',
          scheduledAt: task.deadline,
        })),
        skipDuplicates: true,
      });
      await this.prisma.task.updateMany({
        where: { id: { in: tasks.map((task) => task.id) } },
        data: { status: 'OVERDUE' },
      });
    }
  }

  private chatId(ctx: BotContext): number | undefined {
    return ctx.chat?.id ?? ctx.from?.id;
  }

  private isPermanentRecipientError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;

    const response = 'response' in error ? error.response : undefined;
    if (!response || typeof response !== 'object') return false;

    const errorCode =
      'error_code' in response && typeof response.error_code === 'number'
        ? response.error_code
        : undefined;
    const description =
      'description' in response && typeof response.description === 'string'
        ? response.description.toLowerCase()
        : '';

    return (
      (errorCode === 400 && description.includes('chat not found')) ||
      (errorCode === 403 &&
        (description.includes('bot was blocked') ||
          description.includes('user is deactivated')))
    );
  }

  private parseWibDate(value: string): string {
    const normalized = value.trim().replace(' ', 'T');
    return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)
      ? normalized
      : `${normalized}+07:00`;
  }

  private formatDate(value: Date | string): string {
    return new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  }
}
