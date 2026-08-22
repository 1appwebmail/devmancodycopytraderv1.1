import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { constantProductSwapOut, priceSolPerToken } from "../pricing.js";
import { LAMPORTS_PER_SOL } from "../constants.js";
import type { Position, TradeLogEntry, Venue } from "../types.js";

export interface Reserves {
  sol: bigint; // lamports
  token: bigint; // raw token units
}

export interface PaperState {
  balanceSol: number;
  positions: Position[];
  trades: TradeLogEntry[];
}

export class PaperExecutor {
  private balanceLamports: bigint;
  private positions: Position[] = [];
  private trades: TradeLogEntry[] = [];

  constructor(startingBalanceSol = config.startingPaperBalanceSol, initialState?: PaperState) {
    if (initialState) {
      this.balanceLamports = BigInt(Math.round(initialState.balanceSol * LAMPORTS_PER_SOL));
      this.positions = initialState.positions;
      this.trades = initialState.trades;
    } else {
      this.balanceLamports = BigInt(Math.round(startingBalanceSol * LAMPORTS_PER_SOL));
    }
  }

  /** Simulates a buy fill against the given reserves. Returns null if balance is insufficient. */
  buy(mint: string, venue: Venue, solAmount: number, reserves: Reserves, pool?: string): Position | null {
    const solLamports = BigInt(Math.round(solAmount * LAMPORTS_PER_SOL));
    if (solLamports <= 0n || solLamports > this.balanceLamports) return null;

    const tokensOut = constantProductSwapOut(reserves.sol, reserves.token, solLamports, config.paperFeeBps);
    if (tokensOut <= 0n) return null;

    this.balanceLamports -= solLamports;

    const entryPrice = priceSolPerToken(solLamports, tokensOut);
    const position: Position = {
      id: randomUUID(),
      mint,
      venue,
      pool,
      openedAt: Date.now() / 1000,
      entrySolAmount: solAmount,
      entryTokenAmount: Number(tokensOut),
      entryPrice,
      remainingTokenAmount: Number(tokensOut),
      realizedPnlSol: 0,
      status: "open",
      highWaterPrice: entryPrice,
      ladderTiersHit: [],
    };
    this.positions.push(position);

    this.trades.push({
      timestamp: position.openedAt,
      positionId: position.id,
      mint,
      venue,
      direction: "buy",
      solAmount,
      tokenAmount: Number(tokensOut),
      price: entryPrice,
      reason: "copy_buy",
    });

    return position;
  }

  /** Simulates a sell fill (full or partial) against the given reserves. Returns null if the position isn't open. */
  sell(positionId: string, reserves: Reserves, reason: Position["exitReason"], fraction = 1): TradeLogEntry | null {
    const position = this.positions.find((p) => p.id === positionId && p.status === "open");
    if (!position) return null;

    const tokensToSell = BigInt(Math.round(position.remainingTokenAmount * Math.min(1, Math.max(0, fraction))));
    if (tokensToSell <= 0n) return null;

    const solOutLamports = constantProductSwapOut(reserves.token, reserves.sol, tokensToSell, config.paperFeeBps);
    const solOut = Number(solOutLamports) / LAMPORTS_PER_SOL;

    this.balanceLamports += solOutLamports;

    const costBasisPerToken = position.entrySolAmount / position.entryTokenAmount;
    const realizedPnl = solOut - costBasisPerToken * Number(tokensToSell);

    position.remainingTokenAmount -= Number(tokensToSell);
    position.realizedPnlSol += realizedPnl;

    const fullyClosed = position.remainingTokenAmount <= 0;
    if (fullyClosed) {
      position.status = "closed";
      position.closedAt = Date.now() / 1000;
      position.exitReason = reason;
    }

    const entry: TradeLogEntry = {
      timestamp: Date.now() / 1000,
      positionId: position.id,
      mint: position.mint,
      venue: position.venue,
      direction: "sell",
      solAmount: solOut,
      tokenAmount: Number(tokensToSell),
      price: priceSolPerToken(solOutLamports, tokensToSell),
      reason: reason ?? "manual",
    };
    this.trades.push(entry);
    return entry;
  }

  getState(): PaperState {
    return {
      balanceSol: Number(this.balanceLamports) / LAMPORTS_PER_SOL,
      positions: this.positions,
      trades: this.trades,
    };
  }
}
