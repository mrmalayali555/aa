import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AccountRecord,
  DbSnapshot,
  Modules,
  ScheduleRecord,
  ScheduleStatus,
  UserRecord,
} from "./types";

const DEFAULT_DB_RELATIVE_PATH = "data/db.json";

function nowIso() {
  return new Date().toISOString();
}

function ensureModules(modules?: Partial<Modules>): Modules {
  return {
    read: !!modules?.read,
    hear: !!modules?.hear,
    write: !!modules?.write,
    speak: !!modules?.speak,
  };
}

async function fileExists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export class JsonDb {
  private dbPath: string;
  private snapshot: DbSnapshot | null = null;
  private writePromise: Promise<void> | null = null;

  constructor(dbPath?: string) {
    const resolved =
      dbPath ||
      process.env.DB_PATH ||
      path.resolve(process.cwd(), DEFAULT_DB_RELATIVE_PATH);
    this.dbPath = resolved;
  }

  private async load(): Promise<DbSnapshot> {
    if (this.snapshot) return this.snapshot;

    const dir = path.dirname(this.dbPath);
    await fs.mkdir(dir, { recursive: true });

    if (!(await fileExists(this.dbPath))) {
      this.snapshot = { version: 1, users: [], accounts: [], schedules: [] };
      await this.flush();
      return this.snapshot;
    }

    const raw = await fs.readFile(this.dbPath, "utf8");
    const parsed = JSON.parse(raw) as DbSnapshot;

    // Minimal validation + defaults
    this.snapshot = {
      version: 1,
      users: Array.isArray(parsed.users) ? parsed.users : [],
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      schedules: Array.isArray(parsed.schedules) ? parsed.schedules : [],
    };

    return this.snapshot;
  }

  private async flush(): Promise<void> {
    const snap = await this.load();
    const dir = path.dirname(this.dbPath);
    await fs.mkdir(dir, { recursive: true });
    const json = JSON.stringify(snap, null, 2);

    // serialize writes to avoid corruption on concurrent calls
    this.writePromise = (this.writePromise || Promise.resolve()).then(() =>
      fs.writeFile(this.dbPath, json, "utf8")
    );
    await this.writePromise;
  }

  async getUserByTelegramId(telegramId: string): Promise<UserRecord | null> {
    const db = await this.load();
    return db.users.find((u) => u.telegramId === telegramId) || null;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const db = await this.load();
    return db.users.find((u) => u.id === id) || null;
  }

  async upsertUserByTelegramId(params: {
    telegramId: string;
    username?: string;
  }): Promise<UserRecord> {
    const db = await this.load();
    const existing = db.users.find((u) => u.telegramId === params.telegramId);
    if (existing) {
      const next: UserRecord = {
        ...existing,
        username: params.username ?? existing.username,
      };
      db.users = db.users.map((u) => (u.id === existing.id ? next : u));
      await this.flush();
      return next;
    }

    const user: UserRecord = {
      id: randomUUID(),
      telegramId: params.telegramId,
      username: params.username,
      createdAt: nowIso(),
    };
    db.users.push(user);
    await this.flush();
    return user;
  }

  async getAccountById(id: string): Promise<AccountRecord | null> {
    const db = await this.load();
    return db.accounts.find((a) => a.id === id) || null;
  }

  async getAccountByEmail(email: string): Promise<AccountRecord | null> {
    const db = await this.load();
    return db.accounts.find((a) => a.email === email) || null;
  }

  async listAccountsByUser(userId: string): Promise<AccountRecord[]> {
    const db = await this.load();
    return db.accounts.filter((a) => a.userId === userId);
  }

  async createAccount(params: {
    userId: string;
    email: string;
    password: string;
    modules?: Partial<Modules>;
  }): Promise<AccountRecord> {
    const db = await this.load();
    const existing = db.accounts.find((a) => a.email === params.email);
    if (existing) {
      throw new Error("An account with this email already exists.");
    }

    const ts = nowIso();
    const acc: AccountRecord = {
      id: randomUUID(),
      userId: params.userId,
      email: params.email,
      password: params.password,
      status: true,
      modules: ensureModules(params.modules),
      createdAt: ts,
      updatedAt: ts,
    };
    db.accounts.push(acc);
    await this.flush();
    return acc;
  }

  async deleteAccountByIdForUser(params: {
    accountId: string;
    userId: string;
  }): Promise<AccountRecord | null> {
    const db = await this.load();
    const account = db.accounts.find(
      (a) => a.id === params.accountId && a.userId === params.userId
    );
    if (!account) return null;
    db.accounts = db.accounts.filter((a) => a.id !== params.accountId);
    await this.flush();
    return account;
  }

  async toggleAccountStatusForUser(params: {
    accountId: string;
    userId: string;
  }): Promise<AccountRecord | null> {
    const db = await this.load();
    const account = db.accounts.find(
      (a) => a.id === params.accountId && a.userId === params.userId
    );
    if (!account) return null;

    const next: AccountRecord = {
      ...account,
      status: !account.status,
      updatedAt: nowIso(),
    };
    db.accounts = db.accounts.map((a) => (a.id === account.id ? next : a));
    await this.flush();
    return next;
  }

  async createSchedule(params: {
    createdByUserId: string;
    name: string;
    runAt: Date;
  }): Promise<ScheduleRecord> {
    const db = await this.load();
    const ts = nowIso();
    const schedule: ScheduleRecord = {
      id: randomUUID(),
      createdByUserId: params.createdByUserId,
      name: params.name,
      runAt: params.runAt.toISOString(),
      completed: false,
      status: "pending",
      monitoringStarted: false,
      lastError: null,
      retryCount: 0,
      maxRetries: 5,
      createdAt: ts,
      updatedAt: ts,
    };
    db.schedules.push(schedule);
    await this.flush();
    return schedule;
  }

  async listSchedulesByUser(userId: string): Promise<ScheduleRecord[]> {
    const db = await this.load();
    return db.schedules
      .filter((s) => s.createdByUserId === userId)
      .sort((a, b) => b.runAt.localeCompare(a.runAt));
  }

  async getScheduleById(scheduleId: string): Promise<ScheduleRecord | null> {
    const db = await this.load();
    return db.schedules.find((s) => s.id === scheduleId) || null;
  }

  async deleteScheduleByIdForUser(params: {
    scheduleId: string;
    userId: string;
  }): Promise<boolean> {
    const db = await this.load();
    const exists = db.schedules.some(
      (s) => s.id === params.scheduleId && s.createdByUserId === params.userId
    );
    if (!exists) return false;
    db.schedules = db.schedules.filter((s) => s.id !== params.scheduleId);
    await this.flush();
    return true;
  }

  async updateSchedule(
    scheduleId: string,
    patch: Partial<Omit<ScheduleRecord, "id" | "createdByUserId">> & {
      status?: ScheduleStatus;
    }
  ): Promise<ScheduleRecord | null> {
    const db = await this.load();
    const existing = db.schedules.find((s) => s.id === scheduleId);
    if (!existing) return null;

    const next: ScheduleRecord = {
      ...existing,
      ...patch,
      updatedAt: nowIso(),
    };
    db.schedules = db.schedules.map((s) => (s.id === scheduleId ? next : s));
    await this.flush();
    return next;
  }

  async findSchedulesToMonitor(params: {
    windowStart: Date;
    windowEnd: Date;
  }): Promise<ScheduleRecord[]> {
    const db = await this.load();
    const start = params.windowStart.getTime();
    const end = params.windowEnd.getTime();

    return db.schedules.filter((s) => {
      const runAtMs = new Date(s.runAt).getTime();
      if (!(runAtMs > start && runAtMs <= end)) return false;
      if (s.completed) return false;
      if (s.monitoringStarted) return false;
      if (["running", "paused", "success"].includes(s.status)) return false;
      return true;
    });
  }
}

export const jsonDb = new JsonDb();

