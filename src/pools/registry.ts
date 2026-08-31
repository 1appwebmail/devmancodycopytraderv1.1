import { Connection, PublicKey } from "@solana/web3.js";
import { decodeStruct } from "../parsing/borsh.js";
import { PoolAccountSchema } from "../parsing/schemas.js";
import { withRetry } from "../pricing/withRetry.js";

const ANCHOR_ACCOUNT_DISCRIMINATOR_LEN = 8;

export interface PoolInfo {
  baseMint: string;
  quoteMint: string;
  baseTokenAccount: string;
  quoteTokenAccount: string;
  virtualQuoteReserves: bigint; // extra offset added to the quote SPL balance for AMM pricing
  coinCreator: string; // needed for the live executor's creator_vault PDA — unused by paper pricing
}

/** Caches decoded PumpSwap Pool accounts so we don't re-fetch static pool metadata on every poll. */
export class PoolRegistry {
  private cache = new Map<string, PoolInfo>();
  private inFlight = new Map<string, Promise<PoolInfo | null>>();

  constructor(private connection: Connection) {}

  async resolve(poolAddress: string): Promise<PoolInfo | null> {
    const cached = this.cache.get(poolAddress);
    if (cached) return cached;

    let pending = this.inFlight.get(poolAddress);
    if (!pending) {
      pending = this.fetch(poolAddress);
      this.inFlight.set(poolAddress, pending);
    }
    const result = await pending;
    this.inFlight.delete(poolAddress);
    return result;
  }

  private async fetch(poolAddress: string): Promise<PoolInfo | null> {
    try {
      const info = await withRetry(() => this.connection.getAccountInfo(new PublicKey(poolAddress)));
      if (!info) return null;
      const data = decodeStruct<{
        base_mint: string;
        quote_mint: string;
        pool_base_token_account: string;
        pool_quote_token_account: string;
        virtual_quote_reserves: bigint;
        coin_creator: string;
      }>(info.data.subarray(ANCHOR_ACCOUNT_DISCRIMINATOR_LEN), PoolAccountSchema);

      const resolved: PoolInfo = {
        baseMint: data.base_mint,
        quoteMint: data.quote_mint,
        baseTokenAccount: data.pool_base_token_account,
        quoteTokenAccount: data.pool_quote_token_account,
        virtualQuoteReserves: BigInt(data.virtual_quote_reserves),
        coinCreator: data.coin_creator,
      };
      this.cache.set(poolAddress, resolved);
      return resolved;
    } catch (err) {
      console.error(`PoolRegistry: failed to resolve pool ${poolAddress}:`, err);
      return null;
    }
  }
}
