import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class CreateTaskDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  title?: string;

  @IsOptional()
  @IsString()
  deadline?: string;

  @IsOptional()
  userId?: string | number;
}

export class UpdateDeadlineDto {
  @IsOptional()
  @IsString()
  deadline?: string;
}

export class BulkDeleteTasksDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @Type(() => String)
  taskIds!: string[];
}

export class UpdateTaskDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  title?: string;

  @IsOptional()
  @IsString()
  deadline?: string;

  @IsOptional()
  @IsIn(['PENDING', 'COMPLETED', 'OVERDUE'])
  status?: 'PENDING' | 'COMPLETED' | 'OVERDUE';
}
