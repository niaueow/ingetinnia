import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { CreateTaskDto, UpdateDeadlineDto } from './task.dto.js';
import { TasksService } from './tasks.service.js';

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Post()
  create(@Body() body: CreateTaskDto) {
    return this.tasksService.create(body);
  }

  @Get('today')
  today(@Query('userId') userId?: string) {
    return this.tasksService.today(this.tasksService.parseUserId(userId));
  }

  @Get('upcoming')
  upcoming(@Query('userId') userId?: string) {
    return this.tasksService.upcoming(this.tasksService.parseUserId(userId));
  }

  @Get()
  list(@Query('userId') userId?: string) {
    return this.tasksService.listActive(this.tasksService.parseUserId(userId));
  }

  @Patch(':id/complete')
  complete(@Param('id') id: string, @Query('userId') userId?: string) {
    return this.tasksService.complete(
      id,
      this.tasksService.parseUserId(userId),
    );
  }

  @Patch(':id/deadline')
  updateDeadline(
    @Param('id') id: string,
    @Body() body: UpdateDeadlineDto,
    @Query('userId') userId?: string,
  ) {
    return this.tasksService.updateDeadline(
      id,
      body,
      this.tasksService.parseUserId(userId),
    );
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Query('userId') userId?: string) {
    return this.tasksService.remove(id, this.tasksService.parseUserId(userId));
  }
}
