import dotenv from "dotenv";
import express from "express";
import TelegramBot from "node-telegram-bot-api";
import { examScheduler } from "./schedulers/scheduler";
import { DateTime } from "luxon";
import { jsonDb } from "./storage/db";

dotenv.config();

interface States {
  IDLE: string;
  ADDING_ACCOUNT: string;
  REMOVING_ACCOUNT: string;
  TOGGLING_ACCOUNT: string;
  SELECTING_MODULES: string;
  SETTING_SCHEDULE: string;
  VIEWING_SCHEDULES: string;
  REMOVING_SCHEDULE: string;
}

async function safeEditMessageReplyMarkup(bot: TelegramBot, replyMarkup: any, options: any) {
  try {
    await bot.editMessageReplyMarkup(replyMarkup, options);
  } catch (error: any) {
    if (error.message && error.message.includes("message is not modified")) {
      // Ignore - no change needed
    } else {
      throw error;
    }
  }
}

const token =
  process.env.TELEGRAM_TOKEN ||
  process.env.BOT_TOKEN ||
  "8435011223:AAEeZRiQXJCiNWS6PusvxA1ZCF6uBwIG0uc";
const PORT = process.env.HEALTH_CHECK_PORT || 3001;

let schedulerRunning = false;

const app = express();
app.use(express.json());

app.get("/status/scheduler", (req, res) => {
  try {
    const status = examScheduler.getStatus();
    res.json({
      success: true,
      scheduler: status,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof Error) {
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(500).json({
        success: false,
        error: String(error),
        timestamp: new Date().toISOString(),
      });
    }
  }
});

app.post("/admin/scheduler/stop", async (req, res) => {
  try {
    await examScheduler.stopAllMonitoring();
    examScheduler.stop();
    schedulerRunning = false;

    res.json({
      success: true,
      message: "Scheduler stopped successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: (error as any).message,
      timestamp: new Date().toISOString(),
    });
  }
});

app.post("/admin/scheduler/trigger/:scheduleId", async (req, res) => {
  try {
    const { scheduleId } = req.params;
    await examScheduler.triggerSchedule(scheduleId);

    res.json({
      success: true,
      message: `Schedule ${scheduleId} triggered successfully`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: (error as any).message,
      timestamp: new Date().toISOString(),
    });
  }
});

const userStates = new Map();

const STATES: States = {
  IDLE: "idle",
  ADDING_ACCOUNT: "adding_account",
  REMOVING_ACCOUNT: "removing_account",
  TOGGLING_ACCOUNT: "toggling_account",
  SELECTING_MODULES: "selecting_modules",
  SETTING_SCHEDULE: "setting_schedule",
  VIEWING_SCHEDULES: "viewing_schedules",
  REMOVING_SCHEDULE: "removing_schedule",
};

export const bot = new TelegramBot(token, { polling: true });

(async () => {
  async function start() {
    try {
      app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
      });

      if (schedulerRunning) {
        console.log("⚠️ Scheduler already running, skipping startup");
        return;
      }

      schedulerRunning = true;
      examScheduler.start();
    } catch (err) {
      console.error("❌ Startup error:", err);
      schedulerRunning = false;
      throw err;
    }
  }

  start();

  const mainMenuOptions = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Add an account", callback_data: "add_account" },
          { text: "View added accounts", callback_data: "view_accounts" },
        ],
        [
          { text: "Remove an account", callback_data: "remove_account" },
          { text: "Toggle account status", callback_data: "toggle_account" },
        ],
        [
          { text: "⏰ Schedule scraping", callback_data: "schedule_scraping" },
          { text: "📅 View schedules", callback_data: "view_schedules" },
        ],
        [{ text: "🗑️ Remove schedule", callback_data: "remove_schedule" }],
        [{ text: "Cancel", callback_data: "cancel" }],
      ],
    },
  };

  const getUserState = (userId: string) => {
    if (!userId) return { state: STATES.IDLE };
    return userStates.get(userId) || { state: STATES.IDLE };
  };

  const setUserState = (userId: string, state: string, data = {}) => {
    const newState = {
      ...data,
      state,
    };
    userStates.set(userId, newState);
  };

  const clearUserState = (userId: string) => {
    userStates.delete(userId);
  };

  const isValidEmail = (email: string) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const showMainMenu = (chatId: number, message = "Choose an option:") => {
    return bot.sendMessage(chatId, message, mainMenuOptions);
  };

  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id?.toString();
    const username = msg.from?.username;

    if (!userId) return;

    clearUserState(userId);

    try {
      const existing = await jsonDb.getUserByTelegramId(userId);

      if (!existing) {
        await jsonDb.upsertUserByTelegramId({
          telegramId: userId,
          username: username || `user_${userId}`,
        });
        showMainMenu(
          chatId,
          `Welcome ${username || "User"
          }! Your account has been created.\n\nChoose an option:`
        );
      } else {
        await jsonDb.upsertUserByTelegramId({
          telegramId: userId,
          username: username || existing.username,
        });
        showMainMenu(
          chatId,
          `Welcome back, ${username || "User"}!\n\nChoose an option:`
        );
      }
    } catch (error) {
      console.error("Error in /start command:", error);
      await bot.sendMessage(
        chatId,
        "Sorry, there was an error. Please try again."
      );
    }
  });

  bot.onText(/\/cancel/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id?.toString() || "";
    clearUserState(userId);
    showMainMenu(chatId, "Operation cancelled. Choose an option:");
  });

  bot.onText(/\/state/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id?.toString() || "";
    const state = getUserState(userId);
    bot.sendMessage(
      chatId,
      `Current state:\n${JSON.stringify(state, null, 2)}`
    );
  });

  bot.onText(/\/delete_(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id?.toString();
    const scheduleId = match?.[1];

    if (!userId || !scheduleId) return;

    await handleDeleteSchedule(chatId, userId, scheduleId);
  });


  bot.onText(/\/schedulehelp/, async (msg) => {
    const chatId = msg.chat.id;

    const helpMessage =
      `📚 **Schedule Control Commands**\n\n` +
      `**Basic Commands:**\n` +
      `• \`/status_<scheduleId>\` - View schedule status\n` +
      `• \`/retry_<scheduleId>\` - Retry a failed schedule\n` +
      `• \`/pause_<scheduleId>\` - Pause monitoring\n` +
      `• \`/resume_<scheduleId>\` - Resume paused monitoring\n` +
      `• \`/stop_<scheduleId>\` - Stop schedule completely\n\n` +
      `**How Retries Work:**\n` +
      `• Each schedule has a maximum of 5 retry attempts\n` +
      `• Failed schedules can be retried manually or automatically\n` +
      `• Use /retry command to immediately retry a failed schedule\n` +
      `• Check retry count with /status command\n\n` +
      `**Schedule States:**\n` +
      `• **pending** - Waiting to start\n` +
      `• **running** - Currently monitoring/processing\n` +
      `• **paused** - Temporarily paused\n` +
      `• **failed** - Failed (can retry)\n` +
      `• **success** - Completed successfully\n` +
      `• **stopped** - Manually stopped\n\n` +
      `**Tips:**\n` +
      `• You can pause a schedule and resume it later\n` +
      `• Failed schedules show available commands in status\n` +
      `• Copy schedule ID from "View schedules" menu`;

    await bot.sendMessage(chatId, helpMessage, { parse_mode: "Markdown" });
  });

  bot.onText(/\/pause_(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id?.toString();
    const scheduleId = match?.[1];

    if (!userId || !scheduleId) return;

    try {
      await bot.sendMessage(chatId, "⏸️ Pausing schedule...");

      const schedule = await jsonDb.getScheduleById(scheduleId);
      if (!schedule) {
        await bot.sendMessage(chatId, "❌ Schedule not found.");
        return;
      }

      const user = await jsonDb.getUserByTelegramId(userId);
      if (!user || schedule.createdByUserId !== user.id) {
        await bot.sendMessage(
          chatId,
          "❌ You don't have permission to pause this schedule."
        );
        return;
      }

      await examScheduler.pauseSchedule(scheduleId);
      await bot.sendMessage(
        chatId,
        `⏸️ Schedule "${schedule.name}" paused successfully!\n\n` +
        `Use /resume_${scheduleId} to resume.`
      );
    } catch (error) {
      console.error("Error pausing schedule:", error);
      await bot.sendMessage(
        chatId,
        `❌ Failed to pause schedule: ${(error as Error).message}`
      );
    }
  });

  // Resume schedule command
  bot.onText(/\/resume_(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id?.toString();
    const scheduleId = match?.[1];

    if (!userId || !scheduleId) return;

    try {
      await bot.sendMessage(chatId, "▶️ Resuming schedule...");

      const schedule = await jsonDb.getScheduleById(scheduleId);
      if (!schedule) {
        await bot.sendMessage(chatId, "❌ Schedule not found.");
        return;
      }

      const user = await jsonDb.getUserByTelegramId(userId);
      if (!user || schedule.createdByUserId !== user.id) {
        await bot.sendMessage(
          chatId,
          "❌ You don't have permission to resume this schedule."
        );
        return;
      }

      await examScheduler.resumeSchedule(scheduleId);
      await bot.sendMessage(
        chatId,
        `▶️ Schedule "${schedule.name}" resumed successfully!`
      );
    } catch (error) {
      console.error("Error resuming schedule:", error);
      await bot.sendMessage(
        chatId,
        `❌ Failed to resume schedule: ${(error as Error).message}`
      );
    }
  });

  // Stop schedule command
  bot.onText(/\/stop_(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id?.toString();
    const scheduleId = match?.[1];

    if (!userId || !scheduleId) return;

    try {
      await bot.sendMessage(chatId, "🛑 Stopping schedule...");

      const schedule = await jsonDb.getScheduleById(scheduleId);
      if (!schedule) {
        await bot.sendMessage(chatId, "❌ Schedule not found.");
        return;
      }

      const user = await jsonDb.getUserByTelegramId(userId);
      if (!user || schedule.createdByUserId !== user.id) {
        await bot.sendMessage(
          chatId,
          "❌ You don't have permission to stop this schedule."
        );
        return;
      }

      await examScheduler.stopSchedule(scheduleId);
      await bot.sendMessage(
        chatId,
        `🛑 Schedule "${schedule.name}" stopped completely.`
      );
    } catch (error) {
      console.error("Error stopping schedule:", error);
      await bot.sendMessage(
        chatId,
        `❌ Failed to stop schedule: ${(error as Error).message}`
      );
    }
  });

  bot.on("message", async (msg) => {
    if (msg.text && msg.text.startsWith("/")) return;

    const chatId = msg.chat.id;
    const userId = msg.from?.id?.toString();
    if (!userId) return;

    const userState = getUserState(userId);

    try {
      switch (userState.state) {
        case STATES.ADDING_ACCOUNT:
          await handleAddAccountMessage(chatId, userId, msg.text);
          break;
        case STATES.SELECTING_MODULES:
          await handleModuleSelectionMessage(chatId, userId, msg.text);
          break;
        case STATES.REMOVING_ACCOUNT:
          await handleRemoveAccountMessage(chatId, userId, msg.text);
          break;
        case STATES.TOGGLING_ACCOUNT:
          await handleToggleAccountMessage(chatId, userId, msg.text);
          break;
        case STATES.SETTING_SCHEDULE:
          await handleScheduleCreation(chatId, userId, msg.text);
          break;
        case STATES.REMOVING_SCHEDULE:
          await handleRemoveScheduleMessage(chatId, userId, msg.text);
          break;
        default:
          showMainMenu(chatId, "Please use the menu buttons to navigate:");
      }
    } catch (error) {
      console.error("Error handling message:", error);
      clearUserState(userId);
      await bot.sendMessage(
        chatId,
        "Sorry, there was an error. Please try again."
      );
      showMainMenu(chatId);
    }
  });

  bot.on("callback_query", async (callbackQuery) => {
    const chatId = callbackQuery.message?.chat.id;
    const userId = callbackQuery.from.id.toString();
    const data = callbackQuery.data;
    const messageId = callbackQuery.message?.message_id;

    if (!chatId || !messageId) return;

    await bot.answerCallbackQuery(callbackQuery.id);

    try {
      if (data === "cancel") {
        clearUserState(userId);
        showMainMenu(chatId, "Operation cancelled. Choose an option:");
        return;
      }

      const userState = getUserState(userId);
      switch (userState.state) {
        case STATES.IDLE:
          await handleMainMenuCallback(chatId, userId, data, messageId);
          break;
        case STATES.SELECTING_MODULES:
          await handleModuleCallback(chatId, userId, data, userState);
          break;
        default:
          showMainMenu(chatId, "Please use the menu to navigate:");
      }
    } catch (error) {
      console.error("Error handling callback query:", error);
      clearUserState(userId);
      await bot.sendMessage(
        chatId,
        "❌ Sorry, there was an error. Please try again."
      );
      showMainMenu(chatId);
    }
  });

  const handleMainMenuCallback = async (
    chatId: number,
    userId: string,
    data: string | undefined,
    messageId: number
  ) => {
    switch (data) {
      case "add_account":
        await startAddAccount(chatId, userId, messageId);
        break;
      case "view_accounts":
        await viewAccounts(chatId, userId, messageId);
        break;
      case "remove_account":
        await startRemoveAccount(chatId, userId, messageId);
        break;
      case "toggle_account":
        await startToggleAccount(chatId, userId, messageId);
        break;
      case "schedule_scraping":
        await startScheduleScraping(chatId, userId, messageId);
        break;
      case "view_schedules":
        await viewSchedules(chatId, userId, messageId);
        break;
      case "remove_schedule":
        await startRemoveSchedule(chatId, userId, messageId);
        break;
      default:
        showMainMenu(chatId);
    }
  };

  const startAddAccount = async (
    chatId: number,
    userId: string,
    messageId: number
  ) => {
    setUserState(userId, STATES.ADDING_ACCOUNT);

    if (messageId) {
      await safeEditMessageReplyMarkup(bot,
        { inline_keyboard: [] },
        {
          chat_id: chatId,
          message_id: messageId,
        }
      );
    }

    const cancelOptions = {
      reply_markup: {
        inline_keyboard: [[{ text: "Cancel", callback_data: "cancel" }]],
      },
    };

    await bot.sendMessage(
      chatId,
      `Please provide your account details in the following format:\n\nemail:password\n\nExample:\njohn.doe@example.com:welcome123\n\nOr click Cancel to return to the main menu.`,
      cancelOptions
    );
  };

  const handleAddAccountMessage = async (
    chatId: number,
    userId: string,
    text: string | undefined
  ) => {
    if (!text) return;

    const entry = text.trim();
    const fields = entry.split(":");

    if (fields.length !== 2) {
      await bot.sendMessage(
        chatId,
        "Invalid format. Please ensure your entry follows the specified format:\nemail:password"
      );
      return;
    }

    const [email, password] = fields.map((field) => field.trim());

    if (!password) {
      await bot.sendMessage(
        chatId,
        "All fields are required. Please provide: email:password"
      );
      return;
    }
    if (!isValidEmail(email)) {
      await bot.sendMessage(
        chatId,
        "Invalid email format. Please provide a valid email address."
      );
      return;
    }

    try {
      const existingAccount = await jsonDb.getAccountByEmail(email);
      if (existingAccount) {
        await bot.sendMessage(
          chatId,
          "An account with this email already exists. Please use a different email."
        );
        return;
      }

      setUserState(userId, STATES.SELECTING_MODULES, {
        email,
        password,
        modules: {
          read: false,
          hear: false,
          write: false,
          speak: false,
        },
      });

      await showModuleSelection(chatId, userId);
    } catch (error) {
      console.error("Error checking existing account:", error);
      await bot.sendMessage(chatId, "❌ There was an error. Please try again.");
    }
  };

  const showModuleSelection = async (chatId: number, userId: string) => {
    const userState = getUserState(userId);
    const modules = userState.modules || {
      read: false,
      hear: false,
      write: false,
      speak: false,
    };

    const moduleButtons = [
      [
        {
          text: `📖 Read ${modules.read ? "✅" : "❌"}`,
          callback_data: "toggle_read",
        },
        {
          text: `👂 Hear ${modules.hear ? "✅" : "❌"}`,
          callback_data: "toggle_hear",
        },
      ],
      [
        {
          text: `✏️ Write ${modules.write ? "✅" : "❌"}`,
          callback_data: "toggle_write",
        },
        {
          text: `🗣️ Speak ${modules.speak ? "✅" : "❌"}`,
          callback_data: "toggle_speak",
        },
      ],
      [
        { text: "✅ Confirm Selection", callback_data: "confirm_modules" },
        { text: "Cancel", callback_data: "cancel" },
      ],
    ];

    const selectedCount = Object.values(modules).filter(Boolean).length;
    const moduleStatus =
      selectedCount > 0
        ? `\n\n🎯 Selected modules: ${selectedCount}/4`
        : "\n\n⚠️ No modules selected yet";

    await bot.sendMessage(
      chatId,
      `🔧 **Module Selection**\n\nPlease select the modules you want to enable for this account:${moduleStatus}\n\n` +
      `📖 **Read** - Enable reading capabilities\n` +
      `👂 **Hear** - Enable hearing capabilities\n` +
      `✏️ **Write** - Enable writing capabilities\n` +
      `🗣️ **Speak** - Enable speaking capabilities\n\n` +
      `Click the modules to toggle them on/off, then click "Confirm Selection" when ready.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: moduleButtons,
        },
      }
    );
  };

  const handleModuleCallback = async (
    chatId: number,
    userId: string,
    data: string | undefined,
    userState: any
  ) => {
    if (!data) return;

    const modules = { ...userState.modules };

    switch (data) {
      case "toggle_read":
        modules.read = !modules.read;
        break;
      case "toggle_hear":
        modules.hear = !modules.hear;
        break;
      case "toggle_write":
        modules.write = !modules.write;
        break;
      case "toggle_speak":
        modules.speak = !modules.speak;
        break;
      case "confirm_modules":
        await createAccountWithModules(chatId, userId, userState);
        return;
      default:
        return;
    }

    setUserState(userId, STATES.SELECTING_MODULES, {
      ...userState,
      modules,
    });

    await showModuleSelection(chatId, userId);
  };

  const handleModuleSelectionMessage = async (
    chatId: number,
    userId: string,
    text: string | undefined
  ) => {
    await bot.sendMessage(
      chatId,
      "Please use the buttons above to select modules, or click Cancel to return to the main menu."
    );
  };

  const createAccountWithModules = async (
    chatId: number,
    userId: string,
    userState: any
  ) => {
    try {
      const user = await jsonDb.upsertUserByTelegramId({ telegramId: userId });

      const { modules } = userState;

      await jsonDb.createAccount({
        userId: user.id,
        email: userState.email,
        password: userState.password,
        modules: {
          read: modules.read,
          hear: modules.hear,
          write: modules.write,
          speak: modules.speak,
        },
      });

      clearUserState(userId);

      const enabledModules = Object.entries(modules)
        .filter(([_, enabled]) => enabled)
        .map(([module, _]) => module)
        .join(", ");

      const modulesList = enabledModules || "None";

      await bot.sendMessage(
        chatId,
        `✅ Successfully created account!\n\n` +
        `📧 Email: ${userState.email}\n` +
        `🔧 Enabled Modules: ${modulesList}`
      );

      showMainMenu(chatId, "What would you like to do next?");
    } catch (error) {
      console.error("Error saving account:", error);
      clearUserState(userId);
      await bot.sendMessage(
        chatId,
        "❌ There was an error saving your account. Please try again."
      );
      showMainMenu(chatId);
    }
  };

  const viewAccounts = async (
    chatId: number,
    userId: string,
    messageId: number
  ) => {
    try {
      if (messageId) {
        await safeEditMessageReplyMarkup(bot,
          { inline_keyboard: [] },
          {
            chat_id: chatId,
            message_id: messageId,
          }
        );
      }
      await bot.sendMessage(
        chatId,
        "🔍 Getting your accounts from the database, please wait..."
      );

      const user = await jsonDb.getUserByTelegramId(userId);
      if (!user) {
        await bot.sendMessage(
          chatId,
          "❌ User not found. Please start with /start command."
        );
        return;
      }

      const accounts = await jsonDb.listAccountsByUser(user.id);

      if (accounts && accounts.length > 0) {
        const accountList = accounts
          .map((account, index) => {
            let modules: string[] = [];
            if (account.modules?.hear) modules.push("hear");
            if (account.modules?.read) modules.push("read");
            if (account.modules?.write) modules.push("write");
            if (account.modules?.speak) modules.push("speak");
            const enabledModules = modules.length ? modules.join(", ") : "None";
            const status = account.status ? "✅ Active" : "❌ Inactive";

            return (
              `${index + 1}. **ID:** \`${account.id}\`\n` +
              `   📧 **Email:** ${account.email}\n` +
              `   🔧 **Modules:** ${enabledModules}\n` +
              `   📌 **Status:** ${status}\n`
            );
          })
          .join("\n");

        await bot.sendMessage(
          chatId,
          `📋 **Your Accounts:**\n\n${accountList}`,
          {
            parse_mode: "Markdown",
          }
        );
      } else {
        await bot.sendMessage(chatId, "❌ You have no added accounts.");
      }

      await showMainMenu(chatId, "What would you like to do next?");
    } catch (error) {
      console.error("Error viewing accounts:", error);
      await bot.sendMessage(
        chatId,
        "❌ There was an error retrieving your accounts. Please try again."
      );
      showMainMenu(chatId);
    }
  };

  const startRemoveAccount = async (
    chatId: number,
    userId: string,
    messageId: number
  ) => {
    setUserState(userId, STATES.REMOVING_ACCOUNT);

    if (messageId) {
      await safeEditMessageReplyMarkup(bot,
        { inline_keyboard: [] },
        {
          chat_id: chatId,
          message_id: messageId,
        }
      );
    }

    const cancelOptions = {
      reply_markup: {
        inline_keyboard: [[{ text: "Cancel", callback_data: "cancel" }]],
      },
    };

    await bot.sendMessage(
      chatId,
      "🗑️ Please provide the ID of the account you wish to remove:\n\nOr click Cancel to return to the main menu.",
      cancelOptions
    );
  };

  const handleRemoveAccountMessage = async (
    chatId: number,
    userId: string,
    text: string | undefined
  ) => {
    if (!text) return;

    const accountId = text.trim();

    if (!accountId) {
      await bot.sendMessage(
        chatId,
        "❌ Invalid input. Please provide a valid account ID."
      );
      return;
    }

    try {
      const user = await jsonDb.getUserByTelegramId(userId);

      if (!user) {
        clearUserState(userId);
        await bot.sendMessage(chatId, "❌ User not found. Please try again.");
        showMainMenu(chatId);
        return;
      }

      const deleted = await jsonDb.deleteAccountByIdForUser({
        accountId,
        userId: user.id,
      });
      if (!deleted) {
        await bot.sendMessage(
          chatId,
          "❌ Account not found or it doesn't belong to you. Please check the ID and try again."
        );
        return;
      }

      clearUserState(userId);
      await bot.sendMessage(
        chatId,
        `✅ Successfully removed account: ${deleted.email}`
      );
      showMainMenu(chatId, "What would you like to do next?");
    } catch (error) {
      console.error("Error removing account:", error);
      clearUserState(userId);
      await bot.sendMessage(
        chatId,
        "❌ There was an error removing the account. Please try again."
      );
      showMainMenu(chatId);
    }
  };

  const startToggleAccount = async (
    chatId: number,
    userId: string,
    messageId: number
  ) => {
    setUserState(userId, STATES.TOGGLING_ACCOUNT);

    if (messageId) {
      await safeEditMessageReplyMarkup(bot,
        { inline_keyboard: [] },
        {
          chat_id: chatId,
          message_id: messageId,
        }
      );
    }

    const cancelOptions = {
      reply_markup: {
        inline_keyboard: [[{ text: "Cancel", callback_data: "cancel" }]],
      },
    };

    await bot.sendMessage(
      chatId,
      "⚡ Please provide the ID of the account you wish to toggle (enable/disable):\n\nOr click Cancel to return to the main menu.",
      cancelOptions
    );
  };

  const handleToggleAccountMessage = async (
    chatId: number,
    userId: string,
    text: string | undefined
  ) => {
    if (!text) return;

    const accountId = text.trim();

    if (!accountId) {
      await bot.sendMessage(
        chatId,
        "❌ Invalid input. Please provide a valid account ID."
      );
      return;
    }

    try {
      const user = await jsonDb.getUserByTelegramId(userId);

      if (!user) {
        clearUserState(userId);
        await bot.sendMessage(chatId, "❌ User not found. Please try again.");
        showMainMenu(chatId);
        return;
      }

      const account = await jsonDb.toggleAccountStatusForUser({
        accountId,
        userId: user.id,
      });
      if (!account) {
        await bot.sendMessage(
          chatId,
          "❌ Account not found or it doesn't belong to you. Please check the ID and try again."
        );
        return;
      }

      const statusText = account.status ? "🟢 enabled" : "🔴 disabled";
      clearUserState(userId);
      await bot.sendMessage(
        chatId,
        `✅ Successfully ${statusText} the account: ${account.email}`
      );
      showMainMenu(chatId, "What would you like to do next?");
    } catch (error) {
      console.error("Error toggling account status:", error);
      clearUserState(userId);
      await bot.sendMessage(
        chatId,
        "❌ There was an error toggling the account status. Please try again."
      );
      showMainMenu(chatId);
    }
  };

  const startScheduleScraping = async (
    chatId: number,
    userId: string,
    messageId: number
  ) => {
    setUserState(userId, STATES.SETTING_SCHEDULE);

    if (messageId) {
      await safeEditMessageReplyMarkup(bot,
        { inline_keyboard: [] },
        {
          chat_id: chatId,
          message_id: messageId,
        }
      );
    }

    const cancelOptions = {
      reply_markup: {
        inline_keyboard: [[{ text: "Cancel", callback_data: "cancel" }]],
      },
    };

    await bot.sendMessage(
      chatId,
      "⏰ Please enter the schedule details in **UTC time** using this format:\n\n" +
      "YYYY-MM-DD HH:MM ScheduleName\n\n" +
      "Example:\n" +
      "2024-12-25 09:30 Christmas Booking (UTC)\n" +
      "2025-01-15 14:00 January Session (UTC)\n\n" +
      "Or click Cancel to return to the main menu.",
      cancelOptions
    );
  };

  const handleScheduleCreation = async (
    chatId: number,
    userId: string,
    text: string | undefined
  ) => {
    if (!text) return;

    const input = text.trim();
    const parts = input.split(" ");

    if (parts.length < 3) {
      await bot.sendMessage(
        chatId,
        "❌ Invalid format. Please use: YYYY-MM-DD HH:MM ScheduleName"
      );
      return;
    }

    const datePart = parts[0];
    const timePart = parts[1];
    const nameParts = parts.slice(2);
    const scheduleName =
      nameParts.join(" ") || `Schedule ${new Date().toLocaleString()}`;

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(datePart)) {
      await bot.sendMessage(
        chatId,
        "❌ Invalid date format. Please use YYYY-MM-DD (e.g., 2024-12-25)"
      );
      return;
    }

    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (!timeRegex.test(timePart)) {
      await bot.sendMessage(
        chatId,
        "❌ Invalid time format. Please use HH:MM (e.g., 14:30)"
      );
      return;
    }

    const datetimeStr = `${datePart}T${timePart}:00Z`;
    const runAt = DateTime.fromISO(datetimeStr, { zone: "utc" });

    if (!runAt.isValid) {
      await bot.sendMessage(
        chatId,
        `❌ Invalid date/time: ${runAt.invalidExplanation || "Please check your input"
        }`
      );
      return;
    }

    const allowPastSchedules = process.env.ALLOW_PAST_SCHEDULES === "true";

    if (!allowPastSchedules && runAt.toJSDate() <= new Date()) {
      await bot.sendMessage(
        chatId,
        "❌ Schedule time must be in the future. Please choose a later date/time."
      );
      return;
    }

    try {
      const user = await jsonDb.getUserByTelegramId(userId);
      if (!user) {
        clearUserState(userId);
        await bot.sendMessage(
          chatId,
          "❌ User not found. Please start with /start command."
        );
        showMainMenu(chatId);
        return;
      }

      const newSchedule = await jsonDb.createSchedule({
        name: scheduleName,
        runAt: runAt.toJSDate(),
        createdByUserId: user.id,
      });

      clearUserState(userId);

      const displayTime = runAt.toUTC().toFormat("yyyy-MM-dd HH:mm 'UTC'");

      await bot.sendMessage(
        chatId,
        `✅ Schedule created successfully!\n\n` +
        `📝 Name: ${scheduleName}\n` +
        `⏰ Scheduled for: ${displayTime}\n` +
        `🆔 ID: ${newSchedule.id}\n\n` +
        `All active accounts will run automatically at this time.`
      );

      showMainMenu(chatId, "What would you like to do next?");
    } catch (error) {
      console.error("Schedule creation error:", error);
      clearUserState(userId);
      await bot.sendMessage(
        chatId,
        "❌ Failed to create schedule. Please try again."
      );
      showMainMenu(chatId);
    }
  };

  const viewSchedules = async (
    chatId: number,
    userId: string,
    messageId: number
  ) => {
    try {
      if (messageId) {
        await safeEditMessageReplyMarkup(bot,
          { inline_keyboard: [] },
          {
            chat_id: chatId,
            message_id: messageId,
          }
        );
      }
      await bot.sendMessage(chatId, "🔍 Fetching your schedules...");

      const user = await jsonDb.getUserByTelegramId(userId);
      if (!user) {
        await bot.sendMessage(
          chatId,
          "❌ User not found. Please start with /start command."
        );
        showMainMenu(chatId);
        return;
      }

      // Get all schedules (not just incomplete ones)
      const schedules = await jsonDb.listSchedulesByUser(user.id);

      if (schedules.length === 0) {
        await bot.sendMessage(chatId, "📅 You have no schedules.");
        showMainMenu(chatId, "What would you like to do next?");
        return;
      }

      // Separate active and completed schedules
      const activeSchedules = schedules.filter((s) => !s.completed);
      const completedSchedules = schedules.filter((s) => s.completed);

      let messageText = "";

      // Active Schedules
      if (activeSchedules.length > 0) {
        messageText += `🔵 **Active Schedules (${activeSchedules.length})**\n\n`;

        for (const [index, schedule] of activeSchedules.entries()) {
          const runTime = new Date(schedule.runAt).toLocaleString();
          const lastRun = schedule.lastRun
            ? new Date(schedule.lastRun).toLocaleString()
            : "Never";
          const retryInfo =
            schedule.retryCount !== undefined
              ? `${schedule.retryCount}/${schedule.maxRetries || 5}`
              : "0/5";

          // Status emoji
          let statusEmoji = "⏳";
          if (schedule.status === "running") statusEmoji = "🔄";
          else if (schedule.status === "paused") statusEmoji = "⏸️";
          else if (schedule.status === "failed") statusEmoji = "❌";
          else if (schedule.status === "pending") statusEmoji = "⏳";

          messageText += `${index + 1}. ${statusEmoji} **${schedule.name}**\n`;
          messageText += `   ⏰ **Target:** ${runTime}\n`;
          messageText += `   🆔 **ID:** \`${schedule.id}\`\n`;
          messageText += `   📊 **Status:** ${schedule.status || "pending"}\n`;
          messageText += `   🔁 **Retries:** ${retryInfo}\n`;

          if (schedule.lastRun) {
            messageText += `   📅 *Last Run:* ${lastRun}\n`;
          }

          if (schedule.lastError) {
            const errorPreview =
              schedule.lastError.length > 50
                ? schedule.lastError.substring(0, 50) + "..."
                : schedule.lastError;
            messageText += `   ⚠️ *Last Error:* ${errorPreview}\n`;
          }

          messageText += `   🔧 *Monitoring:* ${schedule.monitoringStarted ? "Yes" : "No"
            }\n`;

          messageText += `   **Commands:** `;
          const commands = [];

          if (schedule.status === "failed") {
            commands.push(`/retry_${schedule.id}`);
          }
          if (schedule.status === "running" || schedule.status === "pending") {
            commands.push(`/pause_${schedule.id}`);
          }
          if (schedule.status === "paused") {
            commands.push(`/resume_${schedule.id}`);
          }
          commands.push(`/status_${schedule.id}`);
          commands.push(`/stop_${schedule.id}`);

          messageText += commands.join(" | ") + "\n\n";
        }
      }

      // Completed Schedules (show last 5)
      if (completedSchedules.length > 0) {
        messageText += `\n✅ **Completed Schedules (Last ${Math.min(
          5,
          completedSchedules.length
        )})**\n\n`;

        for (const [index, schedule] of completedSchedules
          .slice(0, 5)
          .entries()) {
          const runTime = new Date(schedule.runAt).toLocaleString();

          // Status emoji for completed
          let statusEmoji = "✅";
          if (schedule.status === "stopped") statusEmoji = "🛑";
          else if (schedule.status === "failed") statusEmoji = "❌";

          messageText += `${index + 1}. ${statusEmoji} **${schedule.name}**\n`;
          messageText += `   ⏰ **Target:** ${runTime}\n`;
          messageText += `   📊 **Final Status:** ${schedule.status}\n`;

          if (schedule.lastRun) {
            messageText += `   📅 *Completed:* ${new Date(schedule.lastRun).toLocaleString()}\n`;
          }

          messageText += "\n";
        }

        if (completedSchedules.length > 5) {
          messageText += `_...and ${completedSchedules.length - 5
            } more completed schedules_\n\n`;
        }
      }

      messageText += `\n💡 **Tips:**\n`;
      messageText += `• Use /status_<id> to view detailed status\n`;
      messageText += `• Failed schedules can be retried up to 5 times\n`;
      messageText += `• Type /schedulehelp for all commands\n`;
      messageText += `• Use "Remove schedule" to delete schedules`;

      await bot.sendMessage(chatId, messageText, { parse_mode: "Markdown" });

      showMainMenu(chatId, "What would you like to do next?");
    } catch (error) {
      console.error("Error viewing schedules:", error);
      await bot.sendMessage(
        chatId,
        "❌ Failed to retrieve schedules. Please try again."
      );
      showMainMenu(chatId);
    }
  };

  const startRemoveSchedule = async (
    chatId: number,
    userId: string,
    messageId: number
  ) => {
    try {
      if (messageId) {
        await safeEditMessageReplyMarkup(bot,
          { inline_keyboard: [] },
          {
            chat_id: chatId,
            message_id: messageId,
          }
        );
      }

      const user = await jsonDb.getUserByTelegramId(userId);
      if (!user) {
        await bot.sendMessage(
          chatId,
          "❌ User not found. Please start with /start command."
        );
        showMainMenu(chatId);
        return;
      }

      const schedules = await jsonDb.listSchedulesByUser(user.id);
      const activeSchedules = schedules.filter((schedule) => !schedule.completed);

      if (activeSchedules.length === 0) {
        await bot.sendMessage(
          chatId,
          "📅 You have no active schedules to remove."
        );
        showMainMenu(chatId, "What would you like to do next?");
        return;
      }

      setUserState(userId, STATES.REMOVING_SCHEDULE);

      const scheduleList = activeSchedules
        .map((schedule, index) => {
          const runTime = new Date(schedule.runAt).toLocaleString();
          return `${index + 1}. ${schedule.name} (${runTime}) - ID: ${schedule.id}`;
        })
        .join("\n");

      const cancelOptions = {
        reply_markup: {
          inline_keyboard: [[{ text: "Cancel", callback_data: "cancel" }]],
        },
      };

      await bot.sendMessage(
        chatId,
        `🗑️ **Select a schedule to remove:**\n\n${scheduleList}\n\n` +
          `Please enter the **full ID** of the schedule you want to remove:`,
        cancelOptions
      );
    } catch (error) {
      console.error("Error starting remove schedule:", error);
      await bot.sendMessage(
        chatId,
        "❌ Failed to load schedules. Please try again."
      );
      showMainMenu(chatId);
    }
  };

  const handleRemoveScheduleMessage = async (
    chatId: number,
    userId: string,
    text: string | undefined
  ) => {
    if (!text) return;

    const scheduleId = text.trim();

    try {
      const user = await jsonDb.getUserByTelegramId(userId);
      if (!user) {
        clearUserState(userId);
        await bot.sendMessage(chatId, "❌ User not found. Please try again.");
        showMainMenu(chatId);
        return;
      }

      const schedule = await jsonDb.getScheduleById(scheduleId);
      if (!schedule || schedule.createdByUserId !== user.id) {
        await bot.sendMessage(
          chatId,
          "❌ Schedule not found or it doesn't belong to you. Please check the ID and try again."
        );
        return;
      }

      await jsonDb.deleteScheduleByIdForUser({
        scheduleId,
        userId: user.id,
      });

      clearUserState(userId);
      await bot.sendMessage(
        chatId,
        `✅ Successfully removed schedule: "${schedule.name}"`
      );
      showMainMenu(chatId, "What would you like to do next?");
    } catch (error) {
      console.error("Error removing schedule:", error);
      clearUserState(userId);
      await bot.sendMessage(
        chatId,
        "❌ There was an error removing the schedule. Please try again."
      );
      showMainMenu(chatId);
    }
  };

  const handleDeleteSchedule = async (
    chatId: number,
    userId: string,
    scheduleId: string
  ) => {
    try {
      const user = await jsonDb.getUserByTelegramId(userId);
      if (!user) {
        await bot.sendMessage(
          chatId,
          "❌ User not found. Please start with /start command."
        );
        return;
      }

      const deleted = await jsonDb.deleteScheduleByIdForUser({
        scheduleId,
        userId: user.id,
      });

      if (deleted) {
        bot.sendMessage(chatId, "✅ Schedule deleted successfully.");
      } else {
        bot.sendMessage(chatId, "❌ Schedule not found or already completed.");
      }

      showMainMenu(chatId);
    } catch (error) {
      console.error("Error deleting schedule:", error);
      bot.sendMessage(chatId, "❌ Failed to delete schedule");
    }
  };

  bot.on("polling_error", (error) => {
    console.log(`Polling error: ${error.name}: ${error.message}`);
  });

  setInterval(() => {}, 100000);

  process.on("SIGTERM", async () => {
    console.log("🛑 Caught SIGTERM, cleaning up browsers...");
    bot.stopPolling();

    process.exit(0);
  });

  process.on("SIGINT", async () => {
    console.log("Shutting down await bot...");
    bot.stopPolling();
    process.exit(0);
  });
})();
