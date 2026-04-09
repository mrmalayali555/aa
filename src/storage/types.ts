export type Modules = {
  read: boolean;
  hear: boolean;
  write: boolean;
  speak: boolean;
};

export type UserRecord = {
  id: string;
  telegramId: string;
  username?: string;
  createdAt: string; // ISO
};

export type AccountRecord = {
  id: string;
  userId: string;
  email: string;
  password: string;
  status: boolean;
  modules: Modules;
  createdAt: string; // ISO
  updatedAt: string; // ISO
};

export type ScheduleStatus =
  | "pending"
  | "running"
  | "paused"
  | "failed"
  | "success"
  | "stopped"
  | "monitoring";

export type ScheduleRecord = {
  id: string;
  name: string;
  runAt: string; // ISO
  createdByUserId: string;
  completed: boolean;
  status: ScheduleStatus;
  monitoringStarted: boolean;
  lastRun?: string; // ISO
  lastError?: string | null;
  retryCount: number;
  maxRetries: number;
  lastAttemptTime?: string; // ISO
  createdAt: string; // ISO
  updatedAt: string; // ISO
};

export type DbSnapshot = {
  version: 1;
  users: UserRecord[];
  accounts: AccountRecord[];
  schedules: ScheduleRecord[];
};

