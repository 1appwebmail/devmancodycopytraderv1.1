import { Connection, PublicKey } from "@solana/web3.js";
import { withRetry } from "./withRetry.js";

// SPL Token Mint account layout: mintAuthorityOption(4) + mintAuthority(32) + supply:u64(8) + ...
const SUPPLY_OFFSET = 36;

/** Caches each mint's total token supply (raw units) — fixed at creation for pump.fun tokens, doesn't change on migration. */
export class MintInfoCache {
  private cache = new Map<string, bigint>();
  private inFlight = new Map<string, Promise<bigint | null>>();

  constructor(private connection: Connection) {}

  set(mint: string, totalSupplyRaw: bigint) {
    this.cache.set(mint, totalSupplyRaw);
  }

  async resolveTotalSupply(mint: string): Promise<bigint | null> {
    const cached = this.cache.get(mint);
    if (cached !== undefined) return cached;

    let pending = this.inFlight.get(mint);
    if (!pending) {
      pending = this.fetch(mint);
      this.inFlight.set(mint, pending);
    }
    const result = await pending;
    this.inFlight.delete(mint);
    return result;
  }

  private async fetch(mint: string): Promise<bigint | null> {
    try {
      const info = await withRetry(() => this.connection.getAccountInfo(new PublicKey(mint)));
      if (!info || info.data.length < SUPPLY_OFFSET + 8) return null;
      const supply = info.data.readBigUInt64LE(SUPPLY_OFFSET);
      this.cache.set(mint, supply);
      return supply;
    } catch (err) {
      console.error(`MintInfoCache: failed to resolve mint ${mint}:`, err);
      return null;
    }
  }
}
