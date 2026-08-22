export type Venue = "pumpfun" | "pumpswap";
export type TradeDirection = "buy" | "sell";

export interface TradeEvent {
  signature: string;
  slot: number;
  timestamp: number; // unix seconds
  venue: Venue;
  direction: TradeDirection;
  trader: string;
  mint: string;
  solAmount: number; // human units (SOL)
  tokenAmount: number; // raw token units (pre-decimals; pump tokens are 6dp but we treat as opaque qty for now)
  pool?: string; // pumpswap only
  // Reserves as reported by the on-chain event, in raw units (lamports / raw token amount).
  // venue=pumpfun: these are the bonding curve's POST-trade reserves (verified — see
  //   src/parsing/verify_reserves_order.ts) — safe to use directly to price a fill that lands
  //   right after this trade.
  // venue=pumpswap: these are the pool's PRE-trade reserves (verified — see
  //   verify_reserves_order_amm.ts), NOT post-trade, despite the field name. Do not use them
  //   directly for pricing a copy fill — see App.resolveFillReserves, which fetches live pool
  //   reserves instead for this venue.
  postSolReserves: bigint;
  postTokenReserves: bigint;
}

/**
 * A PumpSwap buy/sell as decoded straight off-chain, before we know which side of the pool
 * (base or quote) is actually SOL — that requires the pool account, an async lookup, so it can't
 * be resolved at decode time. See src/ingestion/index.ts, which turns this into a proper
 * TradeEvent once the pool is resolved. Field names deliberately avoid "sol"/"token" — that
 * mapping isn't known yet at this stage.
 */
export interface RawPumpSwapTrade {
  signature: string;
  slot: number;
  timestamp: number;
  trader: string;
  pool: string;
  isBuyEvent: boolean; // true = BuyEvent (base out, quote in), false = SellEvent (base in, quote out)
  baseAmount: number; // the traded base-side amount for this event (out for a buy, in for a sell)
  quoteAmount: number; // the traded quote-side amount for this event (in for a buy, out for a sell)
  baseReservesPre: bigint; // pool's PRE-trade base-token-account balance (verified — see verify_reserves_order_amm.ts)
  quoteReservesPre: bigint; // pool's PRE-trade quote-token-account balance, before any virtual-reserve adjustment
}

export interface CreateEvent {
  signature: string;
  slot: number;
  timestamp: number;
  mint: string;
  bondingCurve: string;
  creator: string;
  name: string;
  symbol: string;
  totalSupplyRaw: bigint;
}

export interface MigrationEvent {
  signature: string;
  slot: number;
  timestamp: number;
  mint: string;
  bondingCurve: string;
}

export type ExecutionMode = "paper" | "live";

export interface Position {
  id: string;
  mint: string;
  venue: Venue;
  pool?: string; // pumpswap only, needed to poll live reserves
  openedAt: number;
  entrySolAmount: number;
  entryTokenAmount: number;
  entryPrice: number; // sol per token
  remainingTokenAmount: number;
  realizedPnlSol: number;
  status: "open" | "closed";
  closedAt?: number;
  exitReason?: "stop_loss" | "take_profit" | "trailing_stop" | "copy_sell" | "manual" | "time_limit" | "ladder_tp";
  highWaterPrice: number; // for trailing stop
  ladderTiersHit: number[]; // indexes into config.ladderTiers already sold off, so each only fires once
  // Resolved asynchronously after the buy (mint total-supply lookup) — see App.resolvePositionMcap.
  // Fully-diluted mcap in USD, for a human-readable "$18.3K" style price display instead of a
  // near-unreadable raw per-token SOL figure like 2.270e-7.
  entryMcapSol?: number;
  entryMcapUsd?: number | null;
  totalSupplyRaw?: string; // bigint as string (JSON-safe); cached once so live mcap needs no repeat RPC lookups
  // Manually toggled from the UI for a moonshot candidate you don't want auto-exited. Suspends
  // every automatic exit for this position — stop_loss/take_profit/trailing_stop/ladder_tp/
  // time_limit AND copy_sell (following the target wallet out). Only the manual Close button
  // still works — that's the whole point of Hold.
  held?: boolean;
  // The target wallet whose buy triggered this position — undefined for positions opened before
  // this field existed (that link was only ever in the live "copy" broadcast, never persisted).
  targetWallet?: string;
}

export interface TradeLogEntry {
  timestamp: number;
  positionId: string;
  mint: string;
  venue: Venue;
  direction: TradeDirection;
  solAmount: number;
  tokenAmount: number;
  price: number;
  reason: string;
  mcapSol?: number; // fully-diluted mcap at our fill price, resolved async (mint total supply lookup)
  mcapUsd?: number | null; // null when the SOL/USD price feed hasn't resolved yet
}

/** Emitted when we copy a target wallet's trade, pairing our fill against theirs for the copy log. */
export interface CopyLogEntry {
  timestamp: number;
  mint: string;
  venue: Venue;
  direction: TradeDirection;
  targetWallet: string;
  targetSolAmount: number;
  targetMcapSol: number | null;
  targetMcapUsd: number | null;
  botSolAmount: number;
  botMcapSol: number | null;
  botMcapUsd: number | null;
  targetSignature: string;
}
