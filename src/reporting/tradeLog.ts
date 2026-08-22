import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { TradeLogEntry } from "../types.js";

const LOG_DIR = path.resolve(process.cwd(), "data");
const LOG_FILE = path.join(LOG_DIR, "trades.jsonl");

let dirReady: Promise<unknown> | null = null;

function ensureDir() {
  if (!dirReady) dirReady = mkdir(LOG_DIR, { recursive: true });
  return dirReady;
}

/** Appends one trade to a local JSON-lines file for audit/history purposes. */
export async function appendTradeLog(entry: TradeLogEntry): Promise<void> {
  await ensureDir();
  await appendFile(LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
}

/**
 * Gross trade volume counts only — NOT PnL. Realized PnL is cost-basis aware
 * and already tracked per-position by PaperExecutor (Position.realizedPnlSol);
 * sum that across positions for an actual PnL figure.
 */
export function summarizeTradeVolume(trades: TradeLogEntry[]): {
  totalTrades: number;
  buys: number;
  sells: number;
  solBought: number;
  solSold: number;
} {
  let buys = 0;
  let sells = 0;
  let solBought = 0;
  let solSold = 0;

  for (const t of trades) {
    if (t.direction === "buy") {
      buys++;
      solBought += t.solAmount;
    } else {
      sells++;
      solSold += t.solAmount;
    }
  }

  return { totalTrades: trades.length, buys, sells, solBought, solSold };
}
