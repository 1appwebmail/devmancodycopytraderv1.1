/**
 * Tracks each target wallet's OBSERVED token holdings per mint, purely from the buy/sell events
 * this bot has itself seen for them — no RPC calls, so it doesn't add latency to the hot path.
 * This is what lets a copy-sell mirror the target's actual sold FRACTION (e.g. they sell 30% of
 * their holdings, we sell 30% of ours) instead of always exiting the full position regardless of
 * how much they actually sold.
 *
 * Necessarily approximate: if the target already held the mint before this bot started watching
 * them (or bought it via a path this bot doesn't decode), their tracked holdings start at 0 and
 * every subsequent sell looks proportionally larger than it really is relative to their true
 * balance. recordSell falls back to a full-exit fraction (1) whenever tracked holdings are 0 or
 * unknown, which is the same behavior this had before fractional tracking existed — a safe
 * default, not a regression.
 */
export class TargetHoldingsTracker {
  private holdings = new Map<string, bigint>(); // `${trader}:${mint}` -> raw token units

  private key(trader: string, mint: string): string {
    return `${trader}:${mint}`;
  }

  recordBuy(trader: string, mint: string, tokenAmountRaw: number): void {
    const key = this.key(trader, mint);
    const current = this.holdings.get(key) ?? 0n;
    this.holdings.set(key, current + BigInt(Math.round(tokenAmountRaw)));
  }

  /** Returns the fraction (0-1] of the target's PRE-sell tracked holdings this sell represents,
   *  then updates tracked holdings down by the sold amount (clamped at 0). Returns 1 (full exit)
   *  if nothing is tracked yet, rather than a meaningless/undefined fraction. */
  recordSell(trader: string, mint: string, tokenAmountRaw: number): number {
    const key = this.key(trader, mint);
    const before = this.holdings.get(key) ?? 0n;
    const sold = BigInt(Math.round(tokenAmountRaw));

    if (before <= 0n) {
      // Nothing tracked (pre-existing holdings, or a venue/path we don't decode) — can't compute
      // a real fraction, so don't invent one. Full exit matches prior behavior.
      return 1;
    }

    const after = sold >= before ? 0n : before - sold;
    this.holdings.set(key, after);

    const fraction = Number(sold) / Number(before);
    return Math.min(1, Math.max(0, fraction));
  }

  /** Exposed for tests/debugging only — not used in the hot path. */
  getHoldings(trader: string, mint: string): bigint {
    return this.holdings.get(this.key(trader, mint)) ?? 0n;
  }
}
