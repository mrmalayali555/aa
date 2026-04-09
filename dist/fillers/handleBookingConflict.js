"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleBookingConflict = void 0;
const handleBookingConflict = async (page) => {
    const overlaySelector = ".cs-overlay__container";
    const discardOtherButtonSelector = "button.cs-button.cs-button--look_tertiary.cs-layer__button";
    try {
        const overlay = await page.$(overlaySelector);
        if (overlay) {
            console.log("⚠️ Booking conflict detected, discarding other booking...");
            await Promise.all([
                page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }),
                page.click(discardOtherButtonSelector),
            ]);
            console.log("✅ Navigated after discarding other booking");
            return true;
        }
    }
    catch (error) {
        console.error("❌ Error handling booking conflict:", error.message);
        return false;
    }
    return false; // no conflict detected
};
exports.handleBookingConflict = handleBookingConflict;
