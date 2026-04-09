"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const detectBookingError = async (page) => {
    try {
        await page.waitForSelector("main.cs-checkout .cs-layer__text.cs-layer__text--error", { visible: true, timeout: 3000 });
        return true;
    }
    catch {
        return false;
    }
};
exports.default = detectBookingError;
