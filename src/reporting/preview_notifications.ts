import { buildCopyBuyNotification, buildCopySellNotification, buildAutonomousExitNotification } from "./notifications.js";
import type { Position, TradeEvent, TradeLogEntry } from "../types.js";

const MINT = "JA1CyLRtuA63b5qFt9jUna3n1o9KXEpy8AFcWNw5pump";
const totalSupplyRaw = 1_000_000_000_000_000n; // 1e9 tokens * 1e6 decimals, the pump.fun standard
const solUsdPrice = 82.0;

// A rawPrice (lamports/raw-token) that works out to roughly $0.000006843 per whole token at $82/SOL
const rawPrice = ((0.000006843 / solUsdPrice) * 1e9) / 1e6;

const targetEvent: TradeEvent = {
  signature: "sig123",
  slot: 1,
  timestamp: Date.now() / 1000,
  venue: "pumpswap",
  direction: "buy",
  trader: "5y3V9XWVZG6rkmcfCgvV5ChqthB1qcgBzDLvGpijPAfb",
  mint: MINT,
  pool: "poolAddr",
  solAmount: 2.5,
  tokenAmount: (2.5 * 1e9) / rawPrice,
  postSolReserves: 0n,
  postTokenReserves: 0n,
};

const entry: TradeLogEntry = {
  timestamp: Date.now() / 1000,
  positionId: "pos1",
  mint: MINT,
  venue: "pumpswap",
  direction: "buy",
  solAmount: 1,
  tokenAmount: (1 * 1e9) / rawPrice,
  price: rawPrice,
  reason: "copy_buy",
};

console.log("=== COPY BUY ===\n");
console.log(buildCopyBuyNotification({ targetEvent, entry, totalSupplyRaw, solUsdPrice }));

console.log("\n\n=== COPY SELL ===\n");
const sellPosition: Position = {
  id: "pos1",
  mint: MINT,
  venue: "pumpswap",
  openedAt: Date.now() / 1000 - 300,
  entrySolAmount: 1,
  entryTokenAmount: entry.tokenAmount,
  entryPrice: rawPrice,
  remainingTokenAmount: 0,
  realizedPnlSol: 0.45,
  status: "closed",
  closedAt: Date.now() / 1000,
  exitReason: "copy_sell",
  highWaterPrice: rawPrice * 1.6,
  ladderTiersHit: [],
  totalSupplyRaw: totalSupplyRaw.toString(),
};
const sellEntry: TradeLogEntry = { ...entry, direction: "sell", solAmount: 1.45, price: rawPrice * 1.45, reason: "copy_sell" };
const targetSellEvent: TradeEvent = { ...targetEvent, direction: "sell", solAmount: 3.2, tokenAmount: (3.2 * 1e9) / (rawPrice * 1.4) };
console.log(buildCopySellNotification({ targetEvent: targetSellEvent, entry: sellEntry, position: sellPosition, totalSupplyRaw, solUsdPrice }));

console.log("\n\n=== TAKE PROFIT (autonomous) ===\n");
console.log(buildAutonomousExitNotification(sellPosition, sellEntry, "take_profit"));

console.log("\n\n=== STOP LOSS (autonomous) ===\n");
const slPosition: Position = { ...sellPosition, realizedPnlSol: -0.22, exitReason: "stop_loss" };
console.log(buildAutonomousExitNotification(slPosition, { ...sellEntry, reason: "stop_loss" }, "stop_loss"));

console.log("\n\n=== Graceful degradation: no SOL/USD price yet, no total supply yet ===\n");
console.log(buildCopyBuyNotification({ targetEvent, entry, totalSupplyRaw: null, solUsdPrice: null }));
