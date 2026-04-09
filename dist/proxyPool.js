"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.proxyPool = exports.USE_PROXIES = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
dotenv_1.default.config();
exports.USE_PROXIES = process.env.USE_PROXIES === "true" || false;
class ProxyPool {
    constructor() {
        this.proxies = [];
        this.currentIndex = 0;
        this.proxyUsage = new Map(); // Track usage count
        this.proxyFilePath = process.env.PROXIES_FILE || process.env.PROXY_FILE_PATH || "./proxies.txt";
        this.loadProxiesFromEnv();
        this.loadProxiesFromFile();
    }
    /**
     * Load proxies from environment variables
     */
    loadProxiesFromEnv() {
        const proxyGroups = new Map();
        for (const [key, rawValue] of Object.entries(process.env)) {
            const match = key.match(/^PROXY_(\d+)_(HOST|PORT|USERNAME|PASSWORD|TYPE)$/i);
            if (!match || !rawValue)
                continue;
            const index = match[1];
            const field = match[2].toUpperCase();
            const group = proxyGroups.get(index) || {};
            if (field === "HOST") {
                group.host = rawValue;
            }
            else if (field === "PORT") {
                group.port = parseInt(rawValue, 10);
            }
            else if (field === "USERNAME") {
                group.username = rawValue;
            }
            else if (field === "PASSWORD") {
                group.password = rawValue;
            }
            else if (field === "TYPE") {
                const type = rawValue.toLowerCase();
                if (type === "http" || type === "https" || type === "socks5") {
                    group.type = type;
                }
            }
            proxyGroups.set(index, group);
        }
        for (const [index, group] of Array.from(proxyGroups.entries()).sort((a, b) => Number(a[0]) - Number(b[0]))) {
            if (group.host && group.port) {
                this.proxies.push({
                    host: group.host,
                    port: group.port,
                    username: group.username,
                    password: group.password,
                    type: group.type ?? "http",
                });
                this.proxyUsage.set(this.proxies.length - 1, 0);
                console.log(`✅ Loaded proxy ${this.proxies.length}: ${group.host}:${group.port}`);
            }
        }
        if (this.proxies.length === 0) {
            console.warn("⚠️ No proxies configured in environment variables");
        }
        else {
            console.log(`📊 Loaded ${this.proxies.length} proxies into pool`);
        }
    }
    loadProxiesFromFile() {
        if (!this.proxyFilePath)
            return;
        const absolutePath = path_1.default.isAbsolute(this.proxyFilePath)
            ? this.proxyFilePath
            : path_1.default.resolve(process.cwd(), this.proxyFilePath);
        if (!fs_1.default.existsSync(absolutePath)) {
            return;
        }
        try {
            const fileContent = fs_1.default.readFileSync(absolutePath, "utf-8");
            const lines = fileContent.split(/\r?\n/).map((line) => line.trim());
            for (const rawLine of lines) {
                if (!rawLine || rawLine.startsWith("#"))
                    continue;
                const parsed = this.parseProxyLine(rawLine);
                if (parsed) {
                    this.proxies.push(parsed);
                    this.proxyUsage.set(this.proxies.length - 1, 0);
                    console.log(`✅ Loaded proxy file entry ${this.proxies.length}: ${parsed.host}:${parsed.port}`);
                }
            }
            if (this.proxies.length > 0) {
                console.log(`📊 Loaded ${this.proxies.length} proxies from file`);
            }
        }
        catch (error) {
            console.error(`❌ Failed to load proxies from file: ${absolutePath}`, error);
        }
    }
    parseProxyLine(rawLine) {
        let line = rawLine.trim();
        let username;
        let password;
        let type = "http";
        if (line.startsWith("http://")) {
            type = "http";
            line = line.replace(/^http:\/\//, "");
        }
        else if (line.startsWith("https://")) {
            type = "https";
            line = line.replace(/^https:\/\//, "");
        }
        else if (line.startsWith("socks5://")) {
            type = "socks5";
            line = line.replace(/^socks5:\/\//, "");
        }
        const authSplit = line.split("@");
        let hostPart = authSplit[0];
        if (authSplit.length === 2) {
            const auth = authSplit[0];
            hostPart = authSplit[1];
            const [user, pass] = auth.split(":");
            username = user;
            password = pass;
        }
        const parts = hostPart.split(":");
        if (parts.length < 2) {
            return null;
        }
        const host = parts[0];
        const port = parseInt(parts[1], 10);
        const typeOverride = parts[2];
        if (parts.length === 3 && (typeOverride === "http" || typeOverride === "https" || typeOverride === "socks5")) {
            type = typeOverride;
        }
        if (!host || Number.isNaN(port)) {
            return null;
        }
        return {
            host,
            port,
            username,
            password,
            type,
        };
    }
    /**
     * Get next proxy from pool (round-robin)
     */
    getNextProxy() {
        if (this.proxies.length === 0) {
            return null;
        }
        const proxy = this.proxies[this.currentIndex];
        // Track usage
        const usage = this.proxyUsage.get(this.currentIndex) || 0;
        this.proxyUsage.set(this.currentIndex, usage + 1);
        // Move to next proxy for next request
        this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
        console.log(`🔄 Assigned proxy ${this.currentIndex + 1}/${this.proxies.length}: ${proxy.host}:${proxy.port} (used ${usage + 1} times)`);
        return proxy;
    }
    /**
     * Get least used proxy (for better distribution)
     */
    getLeastUsedProxy() {
        if (this.proxies.length === 0) {
            return null;
        }
        let minUsage = Infinity;
        let minIndex = 0;
        // Find proxy with least usage
        for (let i = 0; i < this.proxies.length; i++) {
            const usage = this.proxyUsage.get(i) || 0;
            if (usage < minUsage) {
                minUsage = usage;
                minIndex = i;
            }
        }
        const proxy = this.proxies[minIndex];
        const usage = this.proxyUsage.get(minIndex) || 0;
        this.proxyUsage.set(minIndex, usage + 1);
        console.log(`⚖️ Assigned least used proxy ${minIndex + 1}: ${proxy.host}:${proxy.port} (used ${usage + 1} times)`);
        return proxy;
    }
    /**
     * Get random proxy from pool
     */
    getRandomProxy() {
        if (this.proxies.length === 0) {
            return null;
        }
        const randomIndex = Math.floor(Math.random() * this.proxies.length);
        const proxy = this.proxies[randomIndex];
        const usage = this.proxyUsage.get(randomIndex) || 0;
        this.proxyUsage.set(randomIndex, usage + 1);
        console.log(`🎲 Assigned random proxy ${randomIndex + 1}: ${proxy.host}:${proxy.port}`);
        return proxy;
    }
    /**
     * Get specific proxy by index
     */
    getProxyByIndex(index) {
        if (index < 0 || index >= this.proxies.length) {
            return null;
        }
        const proxy = this.proxies[index];
        const usage = this.proxyUsage.get(index) || 0;
        this.proxyUsage.set(index, usage + 1);
        return proxy;
    }
    /**
     * Get proxy pool status
     */
    getStatus() {
        const usage = Array.from(this.proxyUsage.entries()).map(([index, count]) => ({
            index: index + 1,
            proxy: `${this.proxies[index].host}:${this.proxies[index].port}`,
            timesUsed: count,
        }));
        return {
            enabled: exports.USE_PROXIES,
            totalProxies: this.proxies.length,
            currentIndex: this.currentIndex + 1,
            usage,
        };
    }
    /**
     * Reset usage counters
     */
    resetUsage() {
        this.proxyUsage.clear();
        for (let i = 0; i < this.proxies.length; i++) {
            this.proxyUsage.set(i, 0);
        }
        console.log("🔄 Reset proxy usage counters");
    }
    /**
     * Get total number of proxies
     */
    getProxyCount() {
        return this.proxies.length;
    }
}
// Singleton instance
exports.proxyPool = new ProxyPool();
