"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const puppeteer_1 = __importDefault(require("puppeteer"));
(async () => {
    try {
        const browser = await puppeteer_1.default.launch({
            headless: false, // show GUI
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
            ],
            env: {
                DISPLAY: ":99", // use your virtual display (adjust if needed)
            },
        });
        const page = await browser.newPage();
        await page.goto("https://example.com", { waitUntil: "networkidle2" });
        // Take a screenshot
        await page.screenshot({ path: "screenshot.png" });
        console.log("✅ Screenshot saved as screenshot.png");
        // Keep browser open for a bit so you can see it in noVNC
        await new Promise((resolve) => setTimeout(resolve, 150000));
        await browser.close();
    }
    catch (err) {
        console.error("❌ Error launching Puppeteer:", err);
    }
})();
