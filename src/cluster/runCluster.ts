import startBooking from "../booking/book";
import { bot } from "..";
import dotenv from "dotenv";
import { browserPool } from "../browsers/prewarmedBrowserPool";
import { jsonDb } from "../storage/db";

dotenv.config();

interface DisplayInfo {
  display: string;
  displayNumber: string;
  noVncUrl: string;
  vncPort: number;
}

/**
 * OPTIMIZED: Use prewarmed browsers and redirect them in PARALLEL
 */
export const runAllAccountsWithPrewarmedBrowsers = async (
  oid: string,
  scheduleId?: string
) => {
  const startTime = Date.now();
  console.log(`⚡⚡⚡ REDIRECTING PREWARMED BROWSERS - OID: ${oid}`);

  let userTelegramId: string | null = null;

  if (scheduleId) {
    try {
      const schedule = await jsonDb.getScheduleById(scheduleId);
      if (schedule) {
        const user = await jsonDb.getUserById(schedule.createdByUserId);
        userTelegramId = user?.telegramId || null;
      }
    } catch (err) {
      console.error("Failed to get user:", err);
    }
  }

  const sendLog = (message: string) => {
    if (userTelegramId) {
      setImmediate(() => {
        bot
          .sendMessage(userTelegramId, message, { parse_mode: "Markdown" })
          .catch(() => {});
      });
    }
  };

  const bookingUrl = `https://www.goethe.de/coe?lang=en&oid=${oid}`;

  // Get all prewarmed browsers
  const prewarmedBrowsers = browserPool.getAllReadyBrowsers();

  if (prewarmedBrowsers.length === 0) {
    console.error("❌ No prewarmed browsers available!");
    sendLog(
      `❌ **No Browsers Ready**\n\n` +
      `No prewarmed browsers found. Please ensure browsers are warmed up before OID detection.`
    );
    return;
  }

  console.log(
    `🔥 Found ${prewarmedBrowsers.length} prewarmed browsers ready to redirect`
  );

  sendLog(
    `⚡⚡⚡ **OID DETECTED - REDIRECTING NOW**\n` +
    `🆔 OID: ${oid}\n` +
    `🚀 Using ${prewarmedBrowsers.length} prewarmed browsers...`
  );

  // Navigate ALL browsers in PARALLEL
  console.log(`🌐 Redirecting ${prewarmedBrowsers.length} browsers in PARALLEL...`);

  const navigationPromises = prewarmedBrowsers.map((browser) =>
    navigateAndStartBooking(browser, bookingUrl, oid, scheduleId)
  );

  const navResults = await Promise.allSettled(navigationPromises);

  let navSuccessCount = 0;
  navResults.forEach((result, index) => {
    if (result.status === "fulfilled" && result.value) {
      navSuccessCount++;
      console.log(`✅ Browser ${index + 1} redirected successfully`);
    } else {
      console.error(`❌ Browser ${index + 1} failed to redirect`);
    }
  });

  const totalTime = Date.now() - startTime;
  console.log(
    `🎯 Total redirect time: ${totalTime}ms, ${navSuccessCount}/${prewarmedBrowsers.length} successful`
  );

  sendLog(
    `✅ **Browsers Redirected**\n\n` +
    `📊 Success: ${navSuccessCount}/${prewarmedBrowsers.length}\n` +
    `⚡ Total time: ${totalTime}ms\n` +
    `🎯 Booking process started on all browsers!`
  );

  // Update schedule status
  if (scheduleId) {
    setImmediate(async () => {
      try {
        await jsonDb.updateSchedule(scheduleId, {
          completed: true,
          status: navSuccessCount > 0 ? "success" : "failed",
          lastRun: new Date().toISOString(),
          lastError:
            navSuccessCount === 0 ? "All browsers failed to reach page" : null,
        });
      } catch (error) {
        console.error("Failed to update schedule:", error);
      }
    });
  }

  // Browsers will remain open for 5 hours as handled by book.ts
};

async function navigateAndStartBooking(
  browser: any,
  bookingUrl: string,
  oid: string,
  scheduleId?: string
): Promise<boolean> {
  try {
    console.log(`🌐 Browser ${browser.browserNumber}: Redirecting to ${bookingUrl}...`);

    // Navigate to the OID URL - prewarmed browser already has page ready
    await browser.page.goto(bookingUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    console.log(`✅ Browser ${browser.browserNumber}: Reached booking page`);

    // Get chatId for notifications
    let chatId: string | null = null;
    if (scheduleId) {
      try {
        const schedule = await jsonDb.getScheduleById(scheduleId);
        if (schedule) {
          const user = await jsonDb.getUserById(schedule.createdByUserId);
          chatId = user?.telegramId || null;
        }
      } catch (err) {
        console.error("Failed to get user:", err);
      }
    }

    // Create displayInfo from prewarmed browser
    const displayInfo: DisplayInfo = {
      display: browser.display,
      displayNumber: browser.display.replace(":", ""),
      noVncUrl: `http://${process.env.SERVER_IP || "localhost"}:${
        6080 + parseInt(browser.display.replace(":", ""))
      }/vnc.html`,
      vncPort: 5900 + parseInt(browser.display.replace(":", "")),
    };

    // Pass to book.ts - it will handle everything and keep browser alive for 5 hours
    await startBooking(
      browser.page,
      browser.browserNumber,
      oid,
      bot,
      displayInfo,
      chatId
    );

    return true;
  } catch (error) {
    console.error(`❌ Browser ${browser.browserNumber}: Redirect failed:`, error);

    // Even on error, try to pass to book.ts - it will handle retries
    try {
      let chatId: string | null = null;
      if (scheduleId) {
        const schedule = await jsonDb.getScheduleById(scheduleId);
        if (schedule) {
          const user = await jsonDb.getUserById(schedule.createdByUserId);
          chatId = user?.telegramId || null;
        }
      }

      const displayInfo: DisplayInfo = {
        display: browser.display,
        displayNumber: browser.display.replace(":", ""),
        noVncUrl: `http://${process.env.SERVER_IP || "localhost"}:${
          6080 + parseInt(browser.display.replace(":", ""))
        }/vnc.html`,
        vncPort: 5900 + parseInt(browser.display.replace(":", "")),
      };

      await startBooking(
        browser.page,
        browser.browserNumber,
        oid,
        bot,
        displayInfo,
        chatId
      );
    } catch (bookingError) {
      console.error(
        `❌ Browser ${browser.browserNumber}: Failed to start booking:`,
        bookingError
      );
    }

    return false;
  }
}