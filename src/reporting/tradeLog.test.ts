import assert from "node:assert";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { appendTradeLog, summarizeTradeVolume } from "./tradeLog.js";
import type { TradeLogEntry } from "../types.js";

const LOG_FILE = path.resolve(process.cwd(), "data", "trades.jsonl");

function entry(overrides: Partial<TradeLogEntry> = {}): TradeLogEntry {
  return {
    timestamp: Date.now() / 1000,
    positionId: "pos1",
    mint: "MintA",
    venue: "pumpfun",
    direction: "buy",
    solAmount: 1,
    tokenAmount: 1000,
    price: 0.001,
    reason: "copy_buy",
    ...overrides,
  };
}

async function main() {
  await rm(LOG_FILE, { force: true });

  const buy = entry({ direction: "buy", solAmount: 1 });
  const sell = entry({ direction: "sell", solAmount: 1.5 });
  await appendTradeLog(buy);
  await appendTradeLog(sell);

  const content = await readFile(LOG_FILE, "utf8");
  const lines = content.trim().split("\n");
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(JSON.parse(lines[0]), buy);
  assert.deepStrictEqual(JSON.parse(lines[1]), sell);

  const summary = summarizeTradeVolume([buy, sell]);
  assert.strictEqual(summary.totalTrades, 2);
  assert.strictEqual(summary.buys, 1);
  assert.strictEqual(summary.sells, 1);
  assert.strictEqual(summary.solBought, 1);
  assert.strictEqual(summary.solSold, 1.5);

  await rm(LOG_FILE, { force: true });
  console.log("tradeLog.test.ts: all assertions passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
