import { config } from "./config.js";
import type { FilterSettings } from "./settings.js";
import type { TradeEvent, Position } from "./types.js";

export type Decision =
  | { kind: "buy"; mint: string; venue: TradeEvent["venue"]; pool?: string; solAmount: number; reason: "copy_buy" }
  | { kind: "sell"; positionId: string; reason: "copy_sell" };

export interface StrategyState {
  openPositions: Position[];
}

/** mcapUsd/ageSeconds are resolved by the caller (App) before invoking evaluateTrade,
 *  since resolving them can require an RPC lookup (and, for mcap, the live SOL/USD price)
 *  — this file stays pure/sync so it's cheaply unit-testable. Pass null when a filter isn't
 *  active (unresolved values aren't looked up at all in that case; see App.handleTargetTrade). */
export interface TradeContext {
  mcapUsd: number | null;
  ageSeconds: number | null;
}

/**
 * Pure decision function: given one trade event from a target wallet and the
 * current book of open positions, decide whether to copy it. No I/O here —
 * execution (paper or live) happens downstream.
 */
export function evaluateTrade(
  event: TradeEvent,
  state: StrategyState,
  context: TradeContext,
  settings: FilterSettings,
): Decision | null {
  if (event.direction === "buy") {
    return evaluateBuy(event, state, context, settings);
  }
  return evaluateSell(event, state);
}

function evaluateBuy(event: TradeEvent, state: StrategyState, context: TradeContext, settings: FilterSettings): Decision | null {
  const alreadyOpen = state.openPositions.some((p) => p.mint === event.mint && p.status === "open");
  if (alreadyOpen) return null; // don't pyramid into an existing position

  const openCount = state.openPositions.filter((p) => p.status === "open").length;
  if (openCount >= config.maxConcurrentPositions) return null;

  if (!passesFilters(event, context, settings)) return null;

  return {
    kind: "buy",
    mint: event.mint,
    venue: event.venue,
    pool: event.pool,
    solAmount: config.positionSizeSol,
    reason: "copy_buy",
  };
}

function passesFilters(event: TradeEvent, context: TradeContext, settings: FilterSettings): boolean {
  // Target's own buy size — filters out tiny "chart support" buys and, optionally, whales too big
  // to stomach. No RPC lookup needed, it's right there on the event, so this check is unconditional.
  if (settings.minTargetBuySol !== null && event.solAmount < settings.minTargetBuySol) return false;
  if (settings.maxTargetBuySol !== null && event.solAmount > settings.maxTargetBuySol) return false;

  const mcapFilterActive = settings.minMcapUsd !== null || settings.maxMcapUsd !== null;
  if (mcapFilterActive) {
    if (context.mcapUsd === null) return false; // couldn't resolve mcap (or no SOL/USD price yet) but a bound was requested — skip rather than silently ignore the filter
    if (settings.minMcapUsd !== null && context.mcapUsd < settings.minMcapUsd) return false;
    if (settings.maxMcapUsd !== null && context.mcapUsd > settings.maxMcapUsd) return false;
  }

  const ageFilterActive = settings.minAgeSeconds !== null || settings.maxAgeSeconds !== null;
  if (ageFilterActive) {
    if (context.ageSeconds === null) return false;
    if (settings.minAgeSeconds !== null && context.ageSeconds < settings.minAgeSeconds) return false;
    if (settings.maxAgeSeconds !== null && context.ageSeconds > settings.maxAgeSeconds) return false;
  }

  return true;
}

function evaluateSell(event: TradeEvent, state: StrategyState): Decision | null {
  if (!config.copySell) return null;
  const position = state.openPositions.find((p) => p.mint === event.mint && p.status === "open");
  if (!position) return null;

  return { kind: "sell", positionId: position.id, reason: "copy_sell" };
}
