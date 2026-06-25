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
// (different channels firing at once) can never interleave half-written lines,
// and so the size check + rotation below stays consistent with the writes.
let writeChain: Promise<void> = Promise.resolve();
let dirEnsured = false;

// Running size of the active log, in bytes. -1 means "not yet initialised";
// we seed it from the file on disk the first time we write.
let currentBytes = -1;

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
 * Appends one line, rotating first if it would push the active file past the
 * cap. Rotation keeps a single previous generation at `${file}.1` (rename
 * replaces any existing one atomically), so total disk use is bounded at
 * roughly 2× the cap. A cap of 0 disables rotation entirely.
 */
async function appendLine(file: string, line: string): Promise<void> {
    const max = config.gateLogMaxBytes;
    const lineBytes = Buffer.byteLength(line);

    // Seed the byte counter from the existing file once (0 if it doesn't exist).
    if (currentBytes < 0) {
        try {
            currentBytes = (await fs.promises.stat(file)).size;
        } catch {
            currentBytes = 0;
        }
    }

    if (max > 0 && currentBytes > 0 && currentBytes + lineBytes > max) {
        try {
            await fs.promises.rename(file, `${file}.1`);
        } catch {
            // Nothing to rotate yet, or rename failed — keep appending regardless.
        }
        currentBytes = 0;
    }

    await fs.promises.appendFile(file, line);
    currentBytes += lineBytes;
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
        .then(() => appendLine(file, line))
        .catch((err) => {
            if (config.debug) console.warn('Failed to write gate decision log:', err);
        });
}