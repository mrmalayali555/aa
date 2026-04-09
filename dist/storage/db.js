"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.jsonDb = exports.JsonDb = void 0;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = require("node:crypto");
const DEFAULT_DB_RELATIVE_PATH = "data/db.json";
function nowIso() {
    return new Date().toISOString();
}
function ensureModules(modules) {
    return {
        read: !!modules?.read,
        hear: !!modules?.hear,
        write: !!modules?.write,
        speak: !!modules?.speak,
    };
}
async function fileExists(p) {
    try {
        await node_fs_1.promises.access(p);
        return true;
    }
    catch {
        return false;
    }
}
class JsonDb {
    constructor(dbPath) {
        this.snapshot = null;
        this.writePromise = null;
        const resolved = dbPath ||
            process.env.DB_PATH ||
            node_path_1.default.resolve(process.cwd(), DEFAULT_DB_RELATIVE_PATH);
        this.dbPath = resolved;
    }
    async load() {
        if (this.snapshot)
            return this.snapshot;
        const dir = node_path_1.default.dirname(this.dbPath);
        await node_fs_1.promises.mkdir(dir, { recursive: true });
        if (!(await fileExists(this.dbPath))) {
            this.snapshot = { version: 1, users: [], accounts: [], schedules: [] };
            await this.flush();
            return this.snapshot;
        }
        const raw = await node_fs_1.promises.readFile(this.dbPath, "utf8");
        const parsed = JSON.parse(raw);
        // Minimal validation + defaults
        this.snapshot = {
            version: 1,
            users: Array.isArray(parsed.users) ? parsed.users : [],
            accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
            schedules: Array.isArray(parsed.schedules) ? parsed.schedules : [],
        };
        return this.snapshot;
    }
    async flush() {
        const snap = await this.load();
        const dir = node_path_1.default.dirname(this.dbPath);
        await node_fs_1.promises.mkdir(dir, { recursive: true });
        const json = JSON.stringify(snap, null, 2);
        // serialize writes to avoid corruption on concurrent calls
        this.writePromise = (this.writePromise || Promise.resolve()).then(() => node_fs_1.promises.writeFile(this.dbPath, json, "utf8"));
        await this.writePromise;
    }
    async getUserByTelegramId(telegramId) {
        const db = await this.load();
        return db.users.find((u) => u.telegramId === telegramId) || null;
    }
    async getUserById(id) {
        const db = await this.load();
        return db.users.find((u) => u.id === id) || null;
    }
    async upsertUserByTelegramId(params) {
        const db = await this.load();
        const existing = db.users.find((u) => u.telegramId === params.telegramId);
        if (existing) {
            const next = {
                ...existing,
                username: params.username ?? existing.username,
            };
            db.users = db.users.map((u) => (u.id === existing.id ? next : u));
            await this.flush();
            return next;
        }
        const user = {
            id: (0, node_crypto_1.randomUUID)(),
            telegramId: params.telegramId,
            username: params.username,
            createdAt: nowIso(),
        };
        db.users.push(user);
        await this.flush();
        return user;
    }
    async getAccountById(id) {
        const db = await this.load();
        return db.accounts.find((a) => a.id === id) || null;
    }
    async getAccountByEmail(email) {
        const db = await this.load();
        return db.accounts.find((a) => a.email === email) || null;
    }
    async listAccountsByUser(userId) {
        const db = await this.load();
        return db.accounts.filter((a) => a.userId === userId);
    }
    async createAccount(params) {
        const db = await this.load();
        const existing = db.accounts.find((a) => a.email === params.email);
        if (existing) {
            throw new Error("An account with this email already exists.");
        }
        const ts = nowIso();
        const acc = {
            id: (0, node_crypto_1.randomUUID)(),
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
    async deleteAccountByIdForUser(params) {
        const db = await this.load();
        const account = db.accounts.find((a) => a.id === params.accountId && a.userId === params.userId);
        if (!account)
            return null;
        db.accounts = db.accounts.filter((a) => a.id !== params.accountId);
        await this.flush();
        return account;
    }
    async toggleAccountStatusForUser(params) {
        const db = await this.load();
        const account = db.accounts.find((a) => a.id === params.accountId && a.userId === params.userId);
        if (!account)
            return null;
        const next = {
            ...account,
            status: !account.status,
            updatedAt: nowIso(),
        };
        db.accounts = db.accounts.map((a) => (a.id === account.id ? next : a));
        await this.flush();
        return next;
    }
    async createSchedule(params) {
        const db = await this.load();
        const ts = nowIso();
        const schedule = {
            id: (0, node_crypto_1.randomUUID)(),
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
    async listSchedulesByUser(userId) {
        const db = await this.load();
        return db.schedules
            .filter((s) => s.createdByUserId === userId)
            .sort((a, b) => b.runAt.localeCompare(a.runAt));
    }
    async getScheduleById(scheduleId) {
        const db = await this.load();
        return db.schedules.find((s) => s.id === scheduleId) || null;
    }
    async deleteScheduleByIdForUser(params) {
        const db = await this.load();
        const exists = db.schedules.some((s) => s.id === params.scheduleId && s.createdByUserId === params.userId);
        if (!exists)
            return false;
        db.schedules = db.schedules.filter((s) => s.id !== params.scheduleId);
        await this.flush();
        return true;
    }
    async updateSchedule(scheduleId, patch) {
        const db = await this.load();
        const existing = db.schedules.find((s) => s.id === scheduleId);
        if (!existing)
            return null;
        const next = {
            ...existing,
            ...patch,
            updatedAt: nowIso(),
        };
        db.schedules = db.schedules.map((s) => (s.id === scheduleId ? next : s));
        await this.flush();
        return next;
    }
    async findSchedulesToMonitor(params) {
        const db = await this.load();
        const start = params.windowStart.getTime();
        const end = params.windowEnd.getTime();
        return db.schedules.filter((s) => {
            const runAtMs = new Date(s.runAt).getTime();
            if (!(runAtMs > start && runAtMs <= end))
                return false;
            if (s.completed)
                return false;
            if (s.monitoringStarted)
                return false;
            if (["running", "paused", "success"].includes(s.status))
                return false;
            return true;
        });
    }
}
exports.JsonDb = JsonDb;
exports.jsonDb = new JsonDb();
