export interface NlpTaskResponse {
  isTask: boolean;
  title?: string;
  dueDate?: string;
}

export interface NlpTaskResult {
  isTask: true;
  title: string;
  dueDate: string;
}

export interface NlpChatterResult {
  isTask: false;
}
