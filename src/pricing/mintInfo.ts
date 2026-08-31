import { Connection, PublicKey } from "@solana/web3.js";
import { withRetry } from "./withRetry.js";
import { PUMP_STANDARD_TOKEN_SUPPLY_RAW } from "../constants.js";

// SPL Token Mint account layout: mintAuthorityOption(4) + mintAuthority(32) + supply:u64(8) + ...
const SUPPLY_OFFSET = 36;

/**
 * Caches each mint's total token supply (raw units) — fixed at creation for pump.fun tokens,
 * doesn't change on migration.
 *
 * resolveTotalSupply returns instantly using PUMP_STANDARD_TOKEN_SUPPLY_RAW whenever nothing is
 * cached yet, rather than blocking on an RPC round trip — verified via live [timing] log
 * instrumentation that this RPC call was costing ~0.5-1s per copy-trade decision, directly eating
 * into the window where a bad fill vs. the target wallet's price gets worse. A real fetch still
 * runs in the background and overwrites the cache with the verified value once it resolves, so a
 * non-standard mint (rare) self-corrects for any LATER lookup — just not this first, speed-critical
 * one.
 */
export class MintInfoCache {
  private cache = new Map<string, bigint>();
  private verifying = new Set<string>();

  constructor(private connection: Connection) {}

  set(mint: string, totalSupplyRaw: bigint) {
    this.cache.set(mint, totalSupplyRaw);
  }

  async resolveTotalSupply(mint: string): Promise<bigint | null> {
    const cached = this.cache.get(mint);
    if (cached !== undefined) return cached;

    this.cache.set(mint, PUMP_STANDARD_TOKEN_SUPPLY_RAW);
    void this.verifyInBackground(mint);
    return PUMP_STANDARD_TOKEN_SUPPLY_RAW;
  }

  private async verifyInBackground(mint: string): Promise<void> {
    if (this.verifying.has(mint)) return;
    this.verifying.add(mint);
    try {
      const info = await withRetry(() => this.connection.getAccountInfo(new PublicKey(mint)));
      if (!info || info.data.length < SUPPLY_OFFSET + 8) return;
      const supply = info.data.readBigUInt64LE(SUPPLY_OFFSET);
      this.cache.set(mint, supply);
    } catch (err) {
      console.error(`MintInfoCache: background verification failed for mint ${mint}:`, err);
    } finally {
      this.verifying.delete(mint);
    }
  }
}
