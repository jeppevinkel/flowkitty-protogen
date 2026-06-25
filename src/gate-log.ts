import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * One classifier decision, written as a single JSONL line. The transcript is
 * the exact context the gate model saw, so a review can judge the verdict
 * against the same input the model had — nothing more, nothing less.
 */
export interface GateDecisionRecord {
    /** ISO 8601 timestamp of when the decision was made. */
    timestamp: string;
    channelId: string;
    /** The final boolean the gate returned (true => bot will respond). */
    decision: boolean;
    /** The model's raw verdict text (or an error/empty marker). */
    rawResponse: string;
    /** Which model produced the verdict, for when you tune the gate model. */
    model: string;
    /** The transcript the classifier was given, verbatim. */
    transcript: string;
    /** Token usage, when available — handy for tracking gate spend over time. */
    inputTokens?: number;
    outputTokens?: number;
}

// Serialise appends through a single promise chain so concurrent gate calls
// (different channels firing at once) can never interleave half-written lines.
let writeChain: Promise<void> = Promise.resolve();
let dirEnsured = false;

/** Lazily ensures the log's directory exists (mirrors history.ts's ./data). */
function ensureDir(file: string): void {
    if (dirEnsured) return;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch {
        // Best-effort; the append below will surface any real problem.
    }
    dirEnsured = true;
}

/**
 * Appends a decision record to the gate log. No-ops when logging is disabled
 * (empty GATE_LOG_FILE). Fire-and-forget: failures are swallowed (logged in
 * debug) so logging can never take the bot down or stall a response.
 */
export function logGateDecision(record: GateDecisionRecord): void {
    const file = config.gateLogFile;
    if (!file) return;
    ensureDir(file);
    const line = JSON.stringify(record) + '\n';
    writeChain = writeChain
        .then(() => fs.promises.appendFile(file, line))
        .catch((err) => {
            if (config.debug) console.warn('Failed to write gate decision log:', err);
        });
}