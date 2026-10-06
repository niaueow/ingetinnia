export interface CreateTaskDto {
  title?: string;
  deadline?: string;
  userId?: string | number;
}

export interface UpdateDeadlineDto {
  deadline?: string;
}
