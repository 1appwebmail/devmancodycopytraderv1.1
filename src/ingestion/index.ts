import { Connection } from "@solana/web3.js";
import { EventEmitter } from "node:events";
import { config } from "../config.js";
import { startGrpcSource } from "./grpcSource.js";
import { decodeTransaction } from "./decodeTransaction.js";
import { PoolRegistry } from "../pools/registry.js";
import { WSOL_MINT, LAMPORTS_PER_SOL } from "../constants.js";
import type { TradeEvent, CreateEvent, MigrationEvent, RawPumpSwapTrade } from "../types.js";

export interface IngestionEvents {
  trade: (evt: TradeEvent) => void;
  create: (evt: CreateEvent) => void;
  migration: (evt: MigrationEvent) => void;
  status: (source: string, status: "connected" | "disconnected" | "error", detail?: string) => void;
}

const SEEN_SIGNATURE_CAP = 10_000;

export class Ingestion extends EventEmitter {
  private seenSignatures = new Set<string>();
  private poolRegistry: PoolRegistry;
  private targetWalletSet: Set<string>;

  constructor(connection: Connection, poolRegistry?: PoolRegistry) {
    super();
    this.poolRegistry = poolRegistry ?? new PoolRegistry(connection);
    this.targetWalletSet = new Set(config.targetWallets);
  }

  getPoolRegistry(): PoolRegistry {
    return this.poolRegistry;
  }

  start() {
    const sources: { name: string; endpoint: string; token?: string }[] = [];
    if (config.grpc.publicnode.endpoint) {
      sources.push({ name: "publicnode", endpoint: config.grpc.publicnode.endpoint, token: config.grpc.publicnode.token });
    }
    if (config.grpc.helius.endpoint) {
      sources.push({ name: "helius", endpoint: config.grpc.helius.endpoint, token: config.grpc.helius.token });
    }
    if (sources.length === 0) {
      throw new Error("No gRPC sources configured");
    }

    for (const src of sources) {
      startGrpcSource({
        name: src.name,
        endpoint: src.endpoint,
        token: src.token,
        targetWallets: config.targetWallets,
        onTransaction: (info, slot) => this.handleTransaction(info, slot),
        onStatus: (source, status, detail) => this.emit("status", source, status, detail),
      });
    }
  }

  private markSeen(signature: string): boolean {
    if (this.seenSignatures.has(signature)) return true;
    this.seenSignatures.add(signature);
    if (this.seenSignatures.size > SEEN_SIGNATURE_CAP) {
      const first = this.seenSignatures.values().next().value;
      if (first !== undefined) this.seenSignatures.delete(first);
    }
    return false;
  }

  private async handleTransaction(info: Parameters<typeof decodeTransaction>[0], slot: number) {
    const decoded = decodeTransaction(info, slot);
    if (
      decoded.trades.length === 0 &&
      decoded.pumpSwapTrades.length === 0 &&
      decoded.creates.length === 0 &&
      decoded.migrations.length === 0
    ) {
      return;
    }

    const signature =
      decoded.trades[0]?.signature ??
      decoded.pumpSwapTrades[0]?.signature ??
      decoded.creates[0]?.signature ??
      decoded.migrations[0]?.signature;
    if (signature && this.markSeen(signature)) return; // already handled via the other gRPC source

    for (const trade of decoded.trades) {
      if (!this.targetWalletSet.has(trade.trader)) continue;
      this.emit("trade", trade);
    }
    for (const raw of decoded.pumpSwapTrades) {
      if (!this.targetWalletSet.has(raw.trader)) continue;
      const trade = await this.resolvePumpSwapTrade(raw);
      if (trade) this.emit("trade", trade);
    }
    for (const create of decoded.creates) {
      this.emit("create", create);
    }
    for (const migration of decoded.migrations) {
      this.emit("migration", migration);
    }
  }

  /**
   * Turns a raw PumpSwap buy/sell into a proper TradeEvent once we know which side of the pool
   * (base or quote) is actually SOL — there's no fixed convention (verified against live pools:
   * some have base=SOL/quote=token, not just the usual base=token/quote=SOL), so the direction,
   * mint, and amounts all have to be re-derived from the pool's actual base_mint/quote_mint
   * rather than assumed. Getting this backwards means misidentifying the mint (as WSOL) AND
   * inverting buy/sell, which is why PumpSwap copying could silently fail on affected pools.
   */
  private async resolvePumpSwapTrade(raw: RawPumpSwapTrade): Promise<TradeEvent | null> {
    const pool = await this.poolRegistry.resolve(raw.pool);
    if (!pool) {
      console.error(`[pumpswap] couldn't resolve pool ${raw.pool} for trade ${raw.signature.slice(0, 12)}… — skipping`);
      return null;
    }

    const solIsQuote = pool.quoteMint === WSOL_MINT;
    const solIsBase = pool.baseMint === WSOL_MINT;
    if (!solIsQuote && !solIsBase) {
      console.error(
        `[pumpswap] pool ${raw.pool} isn't SOL-denominated on either side (base=${pool.baseMint}, quote=${pool.quoteMint}) — skipping, can't price in SOL`,
      );
      return null;
    }

    let mint: string;
    let direction: TradeEvent["direction"];
    let solAmountRaw: number;
    let tokenAmountRaw: number;
    let postSolReserves: bigint;
    let postTokenReserves: bigint;

    if (solIsQuote) {
      // The common case: base = the memecoin, quote = SOL. A BuyEvent (base out, quote in)
      // is the user paying SOL to receive the token — a genuine buy.
      mint = pool.baseMint;
      direction = raw.isBuyEvent ? "buy" : "sell";
      solAmountRaw = raw.quoteAmount;
      tokenAmountRaw = raw.baseAmount;
      // virtual_quote_reserves is defined relative to the quote side structurally, so it only
      // applies here (where quote actually is SOL).
      postSolReserves = raw.quoteReservesPre + pool.virtualQuoteReserves;
      postTokenReserves = raw.baseReservesPre;
    } else {
      // The reversed case: base = SOL, quote = the memecoin. A BuyEvent (base out, quote in)
      // means the user paid the TOKEN to receive SOL — that's actually a sell of the token.
      mint = pool.quoteMint;
      direction = raw.isBuyEvent ? "sell" : "buy";
      solAmountRaw = raw.baseAmount;
      tokenAmountRaw = raw.quoteAmount;
      postSolReserves = raw.baseReservesPre;
      postTokenReserves = raw.quoteReservesPre + pool.virtualQuoteReserves;
    }

    return {
      signature: raw.signature,
      slot: raw.slot,
      timestamp: raw.timestamp,
      venue: "pumpswap",
      direction,
      trader: raw.trader,
      mint,
      pool: raw.pool,
      solAmount: solAmountRaw / LAMPORTS_PER_SOL,
      tokenAmount: tokenAmountRaw,
      postSolReserves,
      postTokenReserves,
    };
  }
}
