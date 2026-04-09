import puppeteer from "puppeteer";
import axios from "axios";
import dns from "dns";
import http from "http";
import https from "https";
import { proxyPool, USE_PROXIES } from "../proxyPool";

// DNS Pre-resolution
dns.resolve4("www.goethe.de", (err, addresses) => {
  if (!err && addresses.length > 0) {
    console.log(`⚡ DNS pre-resolved: goethe.de -> ${addresses[0]}`);
  }
});

// Keep-alive config for faster API calls
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 50,
  keepAliveMsecs: 30000,
});
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  keepAliveMsecs: 30000,
  rejectUnauthorized: false,
});
axios.defaults.httpAgent = httpAgent;
axios.defaults.httpsAgent = httpsAgent;

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "2000", 10);
const MAX_POLL_DURATION_MS = parseInt(
  process.env.MAX_POLL_DURATION_MS || String(30 * 60 * 1000),
  10
);
const API_CAPTURE_MAX_RETRIES = parseInt(
  process.env.API_CAPTURE_MAX_RETRIES || "30",
  10
);
const API_CAPTURE_RETRY_DELAY_MS = parseInt(
  process.env.API_CAPTURE_RETRY_DELAY_MS || "5000",
  10
);

const FALLBACK_API_URLS = [
  "https://termine.goethe.de/termine/api/available-dates?countryIsoCode=in&category=E007&count=200",
];

function buildAxiosProxyOptions(proxy: any): any {
  if (!proxy) return {};
  if (proxy.type === "socks5") {
    console.warn(`⚠️ socks5 proxy is configured, but axios will not use it directly.`);
    return {};
  }
  return {
    proxy: {
      host: proxy.host,
      port: proxy.port,
      protocol: proxy.type,
    },
  };
}

function getAdaptivePollingInterval(targetTime?: Date): number {
  if (!targetTime) return POLL_INTERVAL_MS;
  const msUntil = targetTime.getTime() - Date.now();
  if (msUntil <= 0) return 500;
  if (msUntil <= 10000) return 250;
  if (msUntil <= 20000) return 400;
  if (msUntil <= 60000) return 700;
  if (msUntil <= 120000) return 1200;
  return Math.max(1000, POLL_INTERVAL_MS);
}

function normalizeApiResponse(raw: any): ApiResponse | null {
  if (!raw || typeof raw !== "object") return null;

  if (Array.isArray(raw.DATA)) {
    return raw;
  }

  if (Array.isArray(raw.data)) {
    return { DATA: raw.data };
  }

  if (Array.isArray(raw.exams)) {
    return { DATA: raw.exams };
  }

  return null;
}

interface ExamData {
  oid?: string;
  modules?: any[];
  bookFromStamp?: string;
  bookToStamp?: string;
  eventName?: string;
  locationName?: string;
  [key: string]: any;
}

interface ApiResponse {
  DATA?: ExamData[];
  [key: string]: any;
}

interface PollingOptions {
  targetTime?: Date;
  interval?: number;
  onOidFound?: (oid: string, exam: ExamData) => Promise<void>;
  onTimeout?: () => void;
  maxDurationMs?: number;
}

class ExamApiMonitor {
  private apiUrl: string | null = "https://www.goethe.de/rest/examfinderv3/exams/institute/O%2010000353%2CO%2010000354%2CO%2010000355%2CO%2010000356%2CO%2010000357%2CO%2010000358?sortField=startDate&hasJUGroup=true&dataMode=0&langId=1&langIsoCodes=en&countryIsoCode=in&count=7&start=1&hasERGroup=true&isODP=0&formstruct%5Bcategory%5D=E007&category=E007&formstruct%5Btype%5D=ER&type=ER&defaults=%5Bobject%20Object%5D&apipath=/rest/examfinderv3/exams/institute/O%252010000353%252CO%252010000354%252CO%252010000355%252CO%252010000356%252CO%252010000357%252CO%252010000358&timezone=48&sortOrder=ASC&formfilters=%7B%22category%22:%22E007%22,%22type%22:%22ER%22%7D";
  private alternateApiUrls = FALLBACK_API_URLS;
  private lastActiveSource: string | null = null;
  private timeoutInterval: NodeJS.Timeout | null = null;
  private isPolling = false;
  private shouldStopPolling = false;
  private processingOid = false;
  private processedOids = new Set<string>();
  private consecutiveErrors = 0;
  private maxConsecutiveErrors = 5;
  private lastSuccessfulPoll: Date | null = null;

  async captureApiUrl(
    maxRetries = API_CAPTURE_MAX_RETRIES,
    retryDelay = API_CAPTURE_RETRY_DELAY_MS
  ): Promise<string | null> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`🌐 Attempt ${attempt}/${maxRetries}: Capturing API URL...`);
      let browser = null;
      let proxy: any = null;

      if (USE_PROXIES) {
        proxy = proxyPool.getLeastUsedProxy();
        if (proxy) {
          console.log(`🔒 Using proxy ${proxy.type}://${proxy.host}:${proxy.port} for API capture`);
        }
      }

      try {
        const browserArgs = [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-blink-features=AutomationControlled",
        ];

        if (proxy) {
          browserArgs.push(`--proxy-server=${proxy.type}://${proxy.host}:${proxy.port}`);
        }

        browser = await puppeteer.launch({
          headless: true,
          args: browserArgs,
          timeout: 30000,
        });

        const page = await browser.newPage();
        if (proxy && proxy.username && proxy.password) {
          await page.authenticate({
            username: proxy.username,
            password: proxy.password,
          });
        }

        await page.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        );

        const apiUrl = await new Promise<string | null>(async (resolve) => {
          let captured = false;
          const timeoutId = setTimeout(() => {
            if (!captured) resolve(null);
          }, 25000);

          page.on("response", (response) => {
            const url = response.url();
            if (!captured && url.includes("examfinder")) {
              captured = true;
              clearTimeout(timeoutId);
              resolve(url);
            }
          });

          try {
            await page.goto("https://www.goethe.de/ins/in/en/spr/prf/gzb2.cfm", {
              waitUntil: "networkidle0",
              timeout: 20000,
            });
          } catch (err) {
            console.log("Error capturing url:", err);
          }

          await new Promise((r) => setTimeout(r, 3000));
          if (!captured) {
            clearTimeout(timeoutId);
            resolve(null);
          }
        });

        await browser.close();

        if (apiUrl) {
          console.log(`✅ API URL captured: ${apiUrl}`);
          this.apiUrl = apiUrl;
          this.consecutiveErrors = 0;
          return apiUrl;
        }
      } catch (err) {
        console.error(`❌ Error capturing API URL (attempt ${attempt})`, err);
        if (browser) await browser.close().catch(() => {});
      }

      if (attempt < maxRetries) {
        const wait = Math.min(retryDelay * attempt, 15000);
        await new Promise((r) => setTimeout(r, wait));
      }
    }

    console.error(`❌ Failed to capture API URL after ${maxRetries} attempts`);
    return null;
  }

  private getCandidateApiSources(): string[] {
    const sources = new Set<string>();
    if (this.apiUrl) {
      sources.add(this.apiUrl);
    }
    for (const url of this.alternateApiUrls) {
      sources.add(url);
    }
    return Array.from(sources);
  }

  private async fetchExamDataFromSource(
    url: string,
    useProxy = true
  ): Promise<ApiResponse | null> {
    const proxy = useProxy && USE_PROXIES ? proxyPool.getLeastUsedProxy() : null;
    const axiosOptions: any = {
      timeout: 5000,
      ...buildAxiosProxyOptions(proxy),
    };

    try {
      const response = await axios.get(url, axiosOptions);
      const normalized = normalizeApiResponse(response.data);
      if (!normalized) {
        console.warn(`⚠️ Invalid response shape from source: ${url}`);
        return null;
      }

      this.consecutiveErrors = 0;
      this.lastSuccessfulPoll = new Date();
      this.lastActiveSource = url;
      return normalized;
    } catch (err) {
      this.consecutiveErrors++;
      console.warn(
        `⚠️ API source failed: ${url}${proxy ? ` via proxy ${proxy.host}:${proxy.port}` : ""}`
      );
      return null;
    }
  }

  private async fetchExamDataFromBrowserPage(): Promise<ApiResponse | null> {
    let browser = null;
    let proxy: any = null;

    if (USE_PROXIES) {
      proxy = proxyPool.getLeastUsedProxy();
      if (proxy) {
        console.log(`🔒 Using proxy ${proxy.type}://${proxy.host}:${proxy.port} for browser scrape fallback`);
      }
    }

    try {
      const browserArgs = [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
      ];

      if (proxy) {
        browserArgs.push(`--proxy-server=${proxy.type}://${proxy.host}:${proxy.port}`);
      }

      browser = await puppeteer.launch({
        headless: true,
        args: browserArgs,
        timeout: 30000,
      });

      const page = await browser.newPage();
      if (proxy && proxy.username && proxy.password) {
        await page.authenticate({
          username: proxy.username,
          password: proxy.password,
        });
      }

      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      );

      const data = await new Promise<ApiResponse | null>(async (resolve) => {
        let captured = false;
        const timeoutId = setTimeout(() => {
          if (!captured) resolve(null);
        }, 25000);

        page.on("response", async (response) => {
          const url = response.url();
          if (!captured && url.includes("examfinder")) {
            try {
              const json = await response.json();
              const normalized = normalizeApiResponse(json);
              if (normalized) {
                captured = true;
                clearTimeout(timeoutId);
                resolve(normalized);
              }
            } catch (error) {
              // ignore parse errors and continue
            }
          }
        });

        try {
          await page.goto("https://www.goethe.de/ins/in/en/spr/prf/gzb2.cfm", {
            waitUntil: "networkidle0",
            timeout: 25000,
          });
        } catch (err) {
          console.warn("⚠️ Browser fallback page load failed:", err);
        }

        await new Promise((r) => setTimeout(r, 3000));
        if (!captured) {
          clearTimeout(timeoutId);
          resolve(null);
        }
      });

      if (data?.DATA?.length) {
        console.log("✅ Browser scrape fallback returned exam data");
        return data;
      }
    } catch (err) {
      console.error("❌ Browser scrape fallback error:", err);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }

    return null;
  }

  private async directApiCall(): Promise<ApiResponse | null> {
    const sources = this.getCandidateApiSources();
    for (const source of sources) {
      const data = await this.fetchExamDataFromSource(source);
      if (data?.DATA?.length) {
        return data;
      }
    }

    console.warn("⚠️ All API sources failed. Trying browser page scrape fallback...");
    const fallbackData = await this.fetchExamDataFromBrowserPage();
    if (fallbackData?.DATA?.length) {
      return fallbackData;
    }

    return null;
  }

  private async checkAndRecaptureApiUrl(): Promise<boolean> {
    if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
      console.warn(
        `⚠️ ${this.consecutiveErrors} consecutive errors → recapturing API URL...`
      );
      this.apiUrl = null;
      const newUrl = await this.captureApiUrl(5, 3000);
      if (newUrl) {
        console.log("✅ Successfully recaptured API URL");
        this.consecutiveErrors = 0;
        return true;
      }
      console.error("❌ Failed to recapture API URL");
      return false;
    }
    return true;
  }

  // MODIFIED: Simple polling for ANY exam with OID (no date/time filtering)
  async startPolling(targetTime?: Date, options?: PollingOptions): Promise<void>;
  async startPolling(options?: PollingOptions): Promise<void>;
  async startPolling(targetTimeOrOptions?: Date | PollingOptions, options?: PollingOptions): Promise<void> {
    const resolvedOptions: PollingOptions =
      targetTimeOrOptions instanceof Date
        ? { ...options, targetTime: targetTimeOrOptions }
        : (targetTimeOrOptions ?? {});

    const {
      targetTime,
      interval,
      onOidFound,
      onTimeout,
      maxDurationMs = MAX_POLL_DURATION_MS,
    } = resolvedOptions;

    const defaultInterval = interval ?? getAdaptivePollingInterval(targetTime);

    this.shouldStopPolling = false;
    this.processingOid = false;
    this.processedOids.clear();

    if (!this.apiUrl) {
      if (this.alternateApiUrls.length > 0) {
        console.log("📡 No captured API URL available; using fallback API URLs for polling.");
      } else {
        console.log("📡 Capturing API URL before polling...");
        await this.captureApiUrl();
        if (!this.apiUrl) {
          console.error("❌ Could not capture API URL. Exiting polling.");
          if (onTimeout) await onTimeout();
          return;
        }
      }
    }

    console.log(`🚀 Starting OID polling (checking every ${defaultInterval}ms)...`);

    this.isPolling = true;

    this.timeoutInterval = setTimeout(async () => {
      console.log("⏰ Max polling duration reached");
      this.shouldStopPolling = true;
      this.stopPolling();
      if (onTimeout) await onTimeout();
    }, maxDurationMs);

    const rapidPoll = async () => {
      const currentInterval = interval ?? getAdaptivePollingInterval(targetTime);
      if (this.shouldStopPolling) return this.stopPolling();
      if (this.processingOid) return setTimeout(rapidPoll, currentInterval);

      const canContinue = await this.checkAndRecaptureApiUrl();
      if (!canContinue) {
        this.stopPolling();
        if (onTimeout) await onTimeout();
        return;
      }

      try {
        const data = await this.directApiCall();

        if (!data?.DATA) {
          setTimeout(rapidPoll, interval);
          return;
        }

        // SIMPLIFIED: Just check for ANY exam with OID
        const examsWithOid = data.DATA.filter((exam) => exam.oid);

        if (examsWithOid.length > 0) {
          // Take the first exam with OID
          const exam = examsWithOid[0];

          if (!this.processedOids.has(exam.oid!)) {
            console.log(`🎯 OID FOUND: ${exam.oid}`);
            console.log(`📍 Location: ${exam.locationName || "Unknown"}`);
            console.log(`📅 Event: ${exam.eventName || "Unknown"}`);

            this.processedOids.add(exam.oid!);
            this.processingOid = true;

            // INSTANT CALLBACK - NO WAITING
            if (onOidFound) {
              setImmediate(() => {
                onOidFound(exam.oid!, exam).finally(() => {
                  this.processingOid = false;
                });
              });
            }

            // Stop polling after first OID found
            return this.stopPolling();
          }
        } else {
          console.log(
            `⏳ Polling... (${data.DATA.length} exams, no OID found yet)`
          );
        }
      } catch (err) {
        this.consecutiveErrors++;
        console.error("❌ Polling error:", err);
      }

      setTimeout(rapidPoll, currentInterval);
    };

    setImmediate(rapidPoll);
  }

  stopPolling() {
    if (this.timeoutInterval) clearTimeout(this.timeoutInterval);
    if (this.isPolling) {
      this.isPolling = false;
      this.shouldStopPolling = true;
      console.log("🛑 Polling stopped");
    }
  }

  async forceStopPolling(maxWaitMs = 5000) {
    this.shouldStopPolling = true;
    this.stopPolling();
    const start = Date.now();
    while (this.processingOid && Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  getApiUrl() {
    return this.apiUrl;
  }

  getStatus() {
    return {
      isPolling: this.isPolling,
      apiUrl: this.apiUrl,
      processingOid: this.processingOid,
      processedOids: Array.from(this.processedOids),
      consecutiveErrors: this.consecutiveErrors,
      lastSuccessfulPoll: this.lastSuccessfulPoll,
    };
  }

  async destroy() {
    await this.forceStopPolling();
    this.apiUrl = null;
    this.processedOids.clear();
    this.consecutiveErrors = 0;
  }
}

export const examMonitor = new ExamApiMonitor();
export { ExamApiMonitor };
