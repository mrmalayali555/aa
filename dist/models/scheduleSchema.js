"use strict";
// Updated scheduleSchema.ts with retry support
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importStar(require("mongoose"));
const scheduleSchema = new mongoose_1.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
    },
    runAt: {
        type: Date,
        required: true,
        index: true,
    },
    createdBy: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true,
    },
    completed: {
        type: Boolean,
        default: false,
        index: true,
    },
    status: {
        type: String,
        enum: ["pending", "running", "paused", "failed", "success", "stopped"],
        default: "pending",
        index: true,
    },
    lastRun: {
        type: Date,
    },
    lastError: {
        type: String,
    },
    monitoringStarted: {
        type: Boolean,
        default: false,
        index: true,
    },
    retryCount: {
        type: Number,
        default: 0,
        min: 0,
    },
    maxRetries: {
        type: Number,
        default: 5,
        min: 0,
        max: 20,
    },
    lastAttemptTime: {
        type: Date,
    },
}, {
    timestamps: true,
});
// Compound indexes for efficient queries
scheduleSchema.index({ createdBy: 1, completed: 1 });
scheduleSchema.index({ runAt: 1, completed: 1, status: 1 });
scheduleSchema.index({ monitoringStarted: 1, completed: 1 });
// Virtual for checking if retries are available
scheduleSchema.virtual("canRetry").get(function () {
    return (this.retryCount || 0) < (this.maxRetries || 5) && !this.completed;
});
// Method to increment retry count
scheduleSchema.methods.incrementRetry = async function () {
    this.retryCount = (this.retryCount || 0) + 1;
    this.lastAttemptTime = new Date();
    return await this.save();
};
// Method to reset retry count
scheduleSchema.methods.resetRetries = async function () {
    this.retryCount = 0;
    this.lastAttemptTime = undefined;
    this.lastError = undefined;
    return await this.save();
};
// Static method to find schedules ready for retry
scheduleSchema.statics.findReadyForRetry = function (minMinutesBetweenRetries = 2) {
    const cutoffTime = new Date(Date.now() - minMinutesBetweenRetries * 60 * 1000);
    return this.find({
        completed: false,
        status: "failed",
        $expr: { $lt: ["$retryCount", "$maxRetries"] },
        $or: [
            { lastAttemptTime: { $exists: false } },
            { lastAttemptTime: { $lt: cutoffTime } },
        ],
    }).populate("createdBy");
};
const Schedule = mongoose_1.default.model("Schedule", scheduleSchema);
exports.default = Schedule;
