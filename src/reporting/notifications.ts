import { LAMPORTS_PER_SOL } from "../constants.js";
import { getSolUsdPrice } from "../pricing/solUsd.js";
import type { Position, TradeEvent, TradeLogEntry } from "../types.js";

// pump.fun / PumpSwap tokens are (almost) universally 6-decimal SPL tokens; this is display-only.
const PUMP_TOKEN_DECIMALS = 6;

function pricePerWholeTokenSol(lamportsPerRawToken: number): number {
  return (lamportsPerRawToken / LAMPORTS_PER_SOL) * 10 ** PUMP_TOKEN_DECIMALS;
}

function fmtUsdPrice(usd: number): string {
  return usd >= 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(9)}`;
}

function fmtMcapCompact(usd: number): string {
  if (usd >= 1_000_000) return `${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000) return `${(usd / 1_000).toFixed(1)}K`;
  return usd.toFixed(0);
}

/** "$0.000006843 - 6.8K MC", or just the price if total supply isn't resolved yet, or "N/A" if there's no SOL/USD price yet. */
function priceAndMcapLine(rawPriceLamportsPerToken: number, totalSupplyRaw: bigint | null, solUsdPrice: number | null): string {
  if (solUsdPrice === null) return "N/A";
  const priceSol = pricePerWholeTokenSol(rawPriceLamportsPerToken);
  const priceUsd = priceSol * solUsdPrice;
  const priceStr = fmtUsdPrice(priceUsd);
  if (totalSupplyRaw === null) return priceStr;
  const mcapSol = (rawPriceLamportsPerToken / LAMPORTS_PER_SOL) * Number(totalSupplyRaw);
  const mcapUsd = mcapSol * solUsdPrice;
  return `${priceStr} - ${fmtMcapCompact(mcapUsd)} MC`;
}

/** Just the price, no mcap — for the "Avg Entry" line. */
function priceOnly(rawPriceLamportsPerToken: number, solUsdPrice: number | null): string {
  if (solUsdPrice === null) return "N/A";
  return fmtUsdPrice(pricePerWholeTokenSol(rawPriceLamportsPerToken) * solUsdPrice);
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function mintLine(mint: string): string {
  return `<code>${mint}</code>`;
}

function fmtSigned(n: number, decimals: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(decimals)}`;
}

function pnlCircle(pnlSol: number): string {
  return pnlSol >= 0 ? "🟢" : "🔴";
}

export interface CopyBuyNotificationInput {
  targetEvent: TradeEvent;
  entry: TradeLogEntry;
  totalSupplyRaw: bigint | null;
  solUsdPrice: number | null;
}

export function buildCopyBuyNotification({ targetEvent, entry, totalSupplyRaw, solUsdPrice }: CopyBuyNotificationInput): string {
  // targetEvent.solAmount/tokenAmount give the target's own average fill price (raw lamports/rawtoken).
  const targetPriceRaw = (targetEvent.solAmount * LAMPORTS_PER_SOL) / targetEvent.tokenAmount;
  return [
    `🛫 <b>Detected buy Copy Trade</b>`,
    `Target Wallet: <code>${shortAddr(targetEvent.trader)}</code>`,
    `Trader Buy Amount: ${targetEvent.solAmount.toFixed(4)} SOL`,
    `Trader Price: ${priceAndMcapLine(targetPriceRaw, totalSupplyRaw, solUsdPrice)}`,
    ``,
    `Copy Buy: Mint Address`,
    mintLine(entry.mint),
    `Buy Amount: ${entry.solAmount.toFixed(4)} SOL`,
    `Buy Price: ${priceAndMcapLine(entry.price, totalSupplyRaw, solUsdPrice)}`,
    `Avg Entry: ${priceOnly(entry.price, solUsdPrice)}`,
    ``,
    `🚀 Transaction successful!`,
  ].join("\n");
}

export interface CopySellNotificationInput {
  targetEvent: TradeEvent;
  entry: TradeLogEntry;
  position: Position;
  totalSupplyRaw: bigint | null;
  solUsdPrice: number | null;
}

export function buildCopySellNotification({ targetEvent, entry, position, totalSupplyRaw, solUsdPrice }: CopySellNotificationInput): string {
  const targetPriceRaw = (targetEvent.solAmount * LAMPORTS_PER_SOL) / targetEvent.tokenAmount;
  const pnlPct = position.entrySolAmount > 0 ? (position.realizedPnlSol / position.entrySolAmount) * 100 : 0;
  return [
    `📉 <b>Detected sell Copy Trade</b>`,
    `Target Wallet: <code>${shortAddr(targetEvent.trader)}</code>`,
    `Trader Sell Amount: ${targetEvent.solAmount.toFixed(4)} SOL`,
    `Trader Price: ${priceAndMcapLine(targetPriceRaw, totalSupplyRaw, solUsdPrice)}`,
    ``,
    `Copy Sell: Mint Address`,
    mintLine(entry.mint),
    `Sell Amount: ${entry.solAmount.toFixed(4)} SOL`,
    `Sell Price: ${priceAndMcapLine(entry.price, totalSupplyRaw, solUsdPrice)}`,
    `PnL: ${pnlCircle(position.realizedPnlSol)} ${fmtSigned(position.realizedPnlSol, 4)} SOL (${fmtSigned(pnlPct, 1)}%)`,
    ``,
    `🚀 Transaction successful!`,
  ].join("\n");
}

const AUTONOMOUS_EXIT_LABELS: Record<string, { emoji: string; label: string }> = {
  take_profit: { emoji: "🎯", label: "Take Profit Hit" },
  ladder_tp: { emoji: "🎯", label: "Ladder Take Profit" },
  stop_loss: { emoji: "🛑", label: "Stop Loss Hit" },
  trailing_stop: { emoji: "🔻", label: "Trailing Stop Hit" },
  manual: { emoji: "🖐", label: "Manual Close" },
  time_limit: { emoji: "⏱", label: "Time Limit Exit" },
};

/** For every sell NOT triggered by copying a target's own sell — our own risk-management rules. */
export function buildAutonomousExitNotification(position: Position, entry: TradeLogEntry, reason: string): string {
  const { emoji, label } = AUTONOMOUS_EXIT_LABELS[reason] ?? { emoji: "🔔", label: reason };
  const totalSupplyRaw = position.totalSupplyRaw ? BigInt(position.totalSupplyRaw) : null;
  const solUsdPrice = getSolUsdPrice();
  const pnlPct = position.entrySolAmount > 0 ? (position.realizedPnlSol / position.entrySolAmount) * 100 : 0;
  return [
    `${emoji} <b>${label}</b>`,
    `Mint Address`,
    mintLine(entry.mint),
    `Sell Amount: ${entry.solAmount.toFixed(4)} SOL`,
    `Sell Price: ${priceAndMcapLine(entry.price, totalSupplyRaw, solUsdPrice)}`,
    `PnL: ${pnlCircle(position.realizedPnlSol)} ${fmtSigned(position.realizedPnlSol, 4)} SOL (${fmtSigned(pnlPct, 1)}%)`,
    ``,
    `✅ Transaction successful!`,
  ].join("\n");
}
