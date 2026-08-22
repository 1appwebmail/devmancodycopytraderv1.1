import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { PaperState } from "../executor/paper.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
// Separate files per mode so switching MODE=paper/live in .env never mixes up (or clobbers)
// the other mode's balance and open positions.
const STATE_FILE = path.join(DATA_DIR, `state.${config.mode}.json`);

/**
 * Loads the last-persisted executor state (balance + positions + trades) so a restart picks up
 * exactly where it left off instead of resetting to the starting balance with no open positions.
 * Returns null on first run (no file yet) or if the file is unreadable/corrupt — callers should
 * fall back to a fresh starting state in that case rather than fail to start.
 */
export function loadState(): PaperState | null {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const raw = readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as PaperState;
    if (typeof parsed.balanceSol !== "number" || !Array.isArray(parsed.positions)) return null;
    return parsed;
  } catch (err) {
    console.error(`statePersistence: failed to load ${STATE_FILE}, starting fresh:`, err);
    return null;
  }
}

/**
 * Writes the current executor state to disk synchronously. Called right after every trade
 * (buy/sell/exit), not on a timer — a sync write of a state file this size (a few hundred KB at
 * most for a realistic number of positions) is fast enough not to matter, and synchronous avoids
 * any risk of two overlapping async writes interleaving and corrupting the file.
 */
export function persistState(state: PaperState): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state), "utf8");
  } catch (err) {
    console.error(`statePersistence: failed to save ${STATE_FILE}:`, err);
  }
}
