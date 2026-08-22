import { Connection, PublicKey } from "@solana/web3.js";
import { withRetry } from "./withRetry.js";

/**
 * Resolves each mint's creation timestamp so age filters can work, caching forever
 * (creation time never changes) since it's a per-mint RPC call.
 *
 * A pump.fun mint's first transaction is its creation, so the oldest signature in
 * getSignaturesForAddress is the launch time. For a token with under ~1000 signatures
 * (true for anything actually "fresh," which is the whole point of an age filter) the
 * single default page already contains that oldest entry — no pagination needed. For
 * a mint with more activity than that, we fall back to the oldest entry in that first
 * page, which understates true age; that's an acceptable approximation since a token
 * with 1000+ signatures already isn't "fresh" by any reasonable age-filter threshold.
 */
export class TokenAgeCache {
  private cache = new Map<string, number>(); // mint -> unix seconds
  private inFlight = new Map<string, Promise<number | null>>();

  constructor(private connection: Connection) {}

  set(mint: string, createdAtUnixSeconds: number) {
    this.cache.set(mint, createdAtUnixSeconds);
  }

  async resolveCreatedAt(mint: string): Promise<number | null> {
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

  private async fetch(mint: string): Promise<number | null> {
    try {
      const sigs = await withRetry(() => this.connection.getSignaturesForAddress(new PublicKey(mint), { limit: 1000 }));
      const oldest = sigs.at(-1);
      if (!oldest?.blockTime) return null;
      this.cache.set(mint, oldest.blockTime);
      return oldest.blockTime;
    } catch (err) {
      console.error(`TokenAgeCache: failed to resolve mint ${mint}:`, err);
      return null;
    }
  }
}
