import { Connection } from "@solana/web3.js";
import { EventEmitter } from "node:events";
import { config, type LadderTier } from "./config.js";
import { PaperExecutor, type Reserves } from "./executor/paper.js";
import { PoolRegistry } from "./pools/registry.js";
import { getReservesForPosition } from "./pricing/liveReserves.js";
import { priceSolPerToken } from "./pricing.js";
import { LAMPORTS_PER_SOL } from "./constants.js";
import { getSolUsdPrice } from "./pricing/solUsd.js";
import { persistState } from "./reporting/statePersistence.js";
import type { Position, TradeLogEntry } from "./types.js";

export type ExitReason = NonNullable<Position["exitReason"]>;

/** Pure exit-rule evaluation, kept standalone so it can be unit tested without network I/O. */
export function checkExitConditions(position: Position, currentPrice: number): ExitReason | null {
  const changeFromEntryPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
  if (changeFromEntryPct <= -config.stopLossPct) return "stop_loss";
  if (changeFromEntryPct >= config.takeProfitPct) return "take_profit";

  const dropFromPeakPct = ((position.highWaterPrice - currentPrice) / position.highWaterPrice) * 100;
  if (position.highWaterPrice > position.entryPrice && dropFromPeakPct >= config.trailingStopPct) {
    return "trailing_stop";
  }

  if (config.maxHoldSeconds > 0 && Date.now() / 1000 - position.openedAt >= config.maxHoldSeconds) {
    return "time_limit";
  }

  return null;
}

export interface LadderResult {
  tierIndexes: number[]; // every newly-crossed tier this check found, in case price gapped past more than one between polls
  fractionOfRemaining: number; // combined sell fraction of the position's CURRENT remaining tokens
}

/**
 * Pure ladder take-profit check, kept standalone for unit testing. Sells a slice of the ORIGINAL
 * position at each configured profit tier the price has newly crossed (a position's
 * `ladderTiersHit` tracks which tiers already fired so each one only sells once), leaving
 * whatever's left to keep riding the ordinary trailing-stop/stop-loss/time-limit rules above.
 * If the price jumps past more than one tier between polls, all newly-crossed tiers are combined
 * into a single sell so none of them get silently skipped.
 */
export function checkLadderTiers(position: Position, currentPrice: number, tiers: LadderTier[]): LadderResult | null {
  if (tiers.length === 0 || position.remainingTokenAmount <= 0) return null;

  const changeFromEntryPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
  const newlyHit = tiers
    .map((tier, index) => ({ tier, index }))
    .filter(({ tier, index }) => !position.ladderTiersHit.includes(index) && changeFromEntryPct >= tier.pct);
  if (newlyHit.length === 0) return null;

  const totalFractionOfOriginal = newlyHit.reduce((sum, { tier }) => sum + tier.fraction, 0);
  const tokenAmountToSell = position.entryTokenAmount * totalFractionOfOriginal;
  const fractionOfRemaining = Math.min(1, Math.max(0, tokenAmountToSell / position.remainingTokenAmount));

  return { tierIndexes: newlyHit.map(({ index }) => index), fractionOfRemaining };
}

export interface UnrealizedPnl {
  positionId: string;
  currentPrice: number;
  unrealizedPnlSol: number;
  unrealizedPnlUsd: number | null;
  unrealizedPnlPct: number;
  solUsdPrice: number | null;
  currentMcapSol: number | null;
  currentMcapUsd: number | null;
}

/**
 * Pure PnL calc on the remaining (unsold) portion of a position, kept standalone for unit testing.
 * `currentPrice` is lamports/raw-token (same units as Position.entryPrice, from priceSolPerToken) —
 * it's converted to SOL/raw-token here since entrySolAmount is human SOL. `solUsdPrice` is passed in
 * (rather than read from the live feed inside this pure function) so it stays unit-testable.
 */
export function computeUnrealizedPnl(position: Position, currentPrice: number, solUsdPrice: number | null = null): UnrealizedPnl {
  const costBasisPerToken = position.entrySolAmount / position.entryTokenAmount; // SOL/raw-token
  const remainingCostBasis = costBasisPerToken * position.remainingTokenAmount;
  const currentPriceSol = currentPrice / LAMPORTS_PER_SOL;
  const currentValue = currentPriceSol * position.remainingTokenAmount;
  const unrealizedPnlSol = currentValue - remainingCostBasis;
  const unrealizedPnlPct = remainingCostBasis > 0 ? (unrealizedPnlSol / remainingCostBasis) * 100 : 0;
  const unrealizedPnlUsd = solUsdPrice !== null ? unrealizedPnlSol * solUsdPrice : null;

  let currentMcapSol: number | null = null;
  let currentMcapUsd: number | null = null;
  if (position.totalSupplyRaw) {
    currentMcapSol = currentPriceSol * Number(position.totalSupplyRaw);
    currentMcapUsd = solUsdPrice !== null ? currentMcapSol * solUsdPrice : null;
  }

  return { positionId: position.id, currentPrice, unrealizedPnlSol, unrealizedPnlUsd, unrealizedPnlPct, solUsdPrice, currentMcapSol, currentMcapUsd };
}

/**
 * Polls live reserves for every open paper position and closes it when a
 * stop-loss / take-profit / trailing-stop / max-hold rule fires.
 */
export class PositionMonitor extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private connection: Connection,
    private executor: PaperExecutor,
    private poolRegistry: PoolRegistry,
  ) {
    super();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), config.positionPollIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick() {
    try {
      const openPositions = this.executor.getState().positions.filter((p) => p.status === "open");
      await Promise.all(openPositions.map((p) => this.evaluatePosition(p)));
    } catch (err) {
      // A single bad tick (e.g. one position's RPC call throwing something unexpected) must never
      // kill the polling loop entirely — that would silently stop monitoring every open position's
      // stop-loss/take-profit, not just the one that errored.
      console.error("PositionMonitor: tick failed, will retry next interval:", err);
    }
  }

  private async evaluatePosition(position: Position) {
    const reserves = await this.fetchReserves(position);
    if (!reserves || reserves.token === 0n) return;

    const currentPrice = priceSolPerToken(reserves.sol, reserves.token);
    if (currentPrice > position.highWaterPrice) {
      position.highWaterPrice = currentPrice;
    }

    this.emit("priceUpdate", computeUnrealizedPnl(position, currentPrice, getSolUsdPrice()));

    // held: voids every automatic exit (ladder TP, take-profit, stop-loss, trailing-stop, time
    // limit) for this position — highWaterPrice still tracks the peak so trailing-stop has an
    // accurate reference if hold ever gets turned back off. copy_sell is also voided (see
    // App.handleSellCandidate) — only the manual Close button still works while held.
    if (position.held) return;

    const ladder = checkLadderTiers(position, currentPrice, config.ladderTiers);
    if (ladder) {
      const entry = this.executor.sell(position.id, reserves, "ladder_tp", ladder.fractionOfRemaining);
      if (entry) {
        position.ladderTiersHit.push(...ladder.tierIndexes);
        this.emit("exit", position, entry, "ladder_tp");
        persistState(this.executor.getState());
      }
      return; // re-evaluate the (now smaller) remaining position fresh next tick
    }

    const reason = checkExitConditions(position, currentPrice);
    if (!reason) return;

    const entry = this.executor.sell(position.id, reserves, reason, 1);
    if (entry) {
      this.emit("exit", position, entry, reason);
      persistState(this.executor.getState());
    }
  }

  private async fetchReserves(position: Position): Promise<Reserves | null> {
    return getReservesForPosition(this.connection, position, this.poolRegistry);
  }
}
