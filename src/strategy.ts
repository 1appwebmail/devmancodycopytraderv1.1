import { config } from "./config.js";
import type { FilterSettings } from "./settings.js";
import type { TradeEvent, Position } from "./types.js";

export type Decision =
  | { kind: "buy"; mint: string; venue: TradeEvent["venue"]; pool?: string; solAmount: number; reason: "copy_buy" }
  | { kind: "sell"; positionId: string; reason: "copy_sell"; fraction: number };

export interface StrategyState {
  openPositions: Position[];
}

/** mcapUsd/ageSeconds are resolved by the caller (App) before invoking evaluateTrade,
 *  since resolving them can require an RPC lookup (and, for mcap, the live SOL/USD price)
 *  — this file stays pure/sync so it's cheaply unit-testable. Pass null when a filter isn't
 *  active (unresolved values aren't looked up at all in that case; see App.handleTargetTrade).
 *  sellFraction is only meaningful for sell events — the fraction (0-1] of the target's tracked
 *  holdings this sell represents (see TargetHoldingsTracker), so a partial sell copies
 *  proportionally instead of always fully exiting the position. Pass 1 if unknown/untracked. */
export interface TradeContext {
  mcapUsd: number | null;
  ageSeconds: number | null;
  sellFraction: number | null;
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
  return evaluateSell(event, state, context);
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

/** Every reason evaluateBuy/passesFilters can reject a buy — used only for human-readable
 *  logging (see explainBuySkip below), evaluateTrade's own return type is untouched. */
export type BuySkipReason =
  | "already_open"
  | "max_concurrent_positions"
  | "target_buy_too_small"
  | "target_buy_too_large"
  | "mcap_unresolved"
  | "mcap_too_low"
  | "mcap_too_high"
  | "age_unresolved"
  | "age_too_young"
  | "age_too_old";

/** Single source of truth for WHY a buy fails passesFilters — passesFilters itself just checks
 *  whether this is null, so the two can never drift out of sync with each other. */
function filterFailureReason(event: TradeEvent, context: TradeContext, settings: FilterSettings): BuySkipReason | null {
  // Target's own buy size — filters out tiny "chart support" buys and, optionally, whales too big
  // to stomach. No RPC lookup needed, it's right there on the event, so this check is unconditional.
  if (settings.minTargetBuySol !== null && event.solAmount < settings.minTargetBuySol) return "target_buy_too_small";
  if (settings.maxTargetBuySol !== null && event.solAmount > settings.maxTargetBuySol) return "target_buy_too_large";

  const mcapFilterActive = settings.minMcapUsd !== null || settings.maxMcapUsd !== null;
  if (mcapFilterActive) {
    if (context.mcapUsd === null) return "mcap_unresolved"; // couldn't resolve mcap (or no SOL/USD price yet) but a bound was requested — skip rather than silently ignore the filter
    if (settings.minMcapUsd !== null && context.mcapUsd < settings.minMcapUsd) return "mcap_too_low";
    if (settings.maxMcapUsd !== null && context.mcapUsd > settings.maxMcapUsd) return "mcap_too_high";
  }

  const ageFilterActive = settings.minAgeSeconds !== null || settings.maxAgeSeconds !== null;
  if (ageFilterActive) {
    if (context.ageSeconds === null) return "age_unresolved";
    if (settings.minAgeSeconds !== null && context.ageSeconds < settings.minAgeSeconds) return "age_too_young";
    if (settings.maxAgeSeconds !== null && context.ageSeconds > settings.maxAgeSeconds) return "age_too_old";
  }

  return null;
}

function passesFilters(event: TradeEvent, context: TradeContext, settings: FilterSettings): boolean {
  return filterFailureReason(event, context, settings) === null;
}

/** Mirrors evaluateBuy's checks in the same order, but returns WHY instead of just null — call
 *  this from a logging site (never from the hot decision path) whenever evaluateTrade returned
 *  null for a buy and you want to tell the user what actually happened, instead of always
 *  printing mcap/age context that may not even be the real reason (e.g. a too-small top-up buy). */
export function explainBuySkip(event: TradeEvent, state: StrategyState, context: TradeContext, settings: FilterSettings): BuySkipReason | "already_open" | "max_concurrent_positions" | null {
  const alreadyOpen = state.openPositions.some((p) => p.mint === event.mint && p.status === "open");
  if (alreadyOpen) return "already_open";

  const openCount = state.openPositions.filter((p) => p.status === "open").length;
  if (openCount >= config.maxConcurrentPositions) return "max_concurrent_positions";

  return filterFailureReason(event, context, settings);
}

function evaluateSell(event: TradeEvent, state: StrategyState, context: TradeContext): Decision | null {
  if (!config.copySell) return null;
  const position = state.openPositions.find((p) => p.mint === event.mint && p.status === "open");
  if (!position) return null;

  return { kind: "sell", positionId: position.id, reason: "copy_sell", fraction: context.sellFraction ?? 1 };
}
