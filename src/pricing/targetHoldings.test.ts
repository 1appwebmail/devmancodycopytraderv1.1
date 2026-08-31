import assert from "node:assert";
import { TargetHoldingsTracker } from "./targetHoldings.js";

const WALLET = "TargetWallet111";
const MINT = "MintA111";

// 1. A partial sell after a single buy computes the correct fraction and decrements holdings
{
  const t = new TargetHoldingsTracker();
  t.recordBuy(WALLET, MINT, 1000);
  const fraction = t.recordSell(WALLET, MINT, 300);
  assert.ok(Math.abs(fraction - 0.3) < 1e-9, `expected 0.3, got ${fraction}`);
  assert.strictEqual(t.getHoldings(WALLET, MINT), 700n);
}

// 2. Selling nothing tracked yet (pre-existing holdings, or an undecoded venue) -> full-exit fallback (1)
{
  const t = new TargetHoldingsTracker();
  const fraction = t.recordSell(WALLET, MINT, 500);
  assert.strictEqual(fraction, 1);
  assert.strictEqual(t.getHoldings(WALLET, MINT), 0n);
}

// 3. Selling more than tracked (e.g. rounding, or a partially-unseen buy) -> clamped to 1, holdings clamp at 0, never negative
{
  const t = new TargetHoldingsTracker();
  t.recordBuy(WALLET, MINT, 1000);
  const fraction = t.recordSell(WALLET, MINT, 5000);
  assert.strictEqual(fraction, 1);
  assert.strictEqual(t.getHoldings(WALLET, MINT), 0n);
}

// 4. Multiple buys accumulate before a sell (matches the common "big buy then several top-ups" pattern)
{
  const t = new TargetHoldingsTracker();
  t.recordBuy(WALLET, MINT, 1000);
  t.recordBuy(WALLET, MINT, 500);
  t.recordBuy(WALLET, MINT, 500);
  assert.strictEqual(t.getHoldings(WALLET, MINT), 2000n);
  const fraction = t.recordSell(WALLET, MINT, 1000);
  assert.ok(Math.abs(fraction - 0.5) < 1e-9, `expected 0.5, got ${fraction}`);
  assert.strictEqual(t.getHoldings(WALLET, MINT), 1000n);
}

// 5. A full sell after tracked buys correctly reports fraction 1 and zeroes holdings
{
  const t = new TargetHoldingsTracker();
  t.recordBuy(WALLET, MINT, 1000);
  const fraction = t.recordSell(WALLET, MINT, 1000);
  assert.strictEqual(fraction, 1);
  assert.strictEqual(t.getHoldings(WALLET, MINT), 0n);
}

// 6. Tracking is isolated per (wallet, mint) pair — one target's holdings on one mint never affect another
{
  const t = new TargetHoldingsTracker();
  t.recordBuy(WALLET, MINT, 1000);
  t.recordBuy("OtherWallet222", MINT, 5000);
  t.recordBuy(WALLET, "OtherMint222", 9000);
  assert.strictEqual(t.getHoldings(WALLET, MINT), 1000n);
  assert.strictEqual(t.getHoldings("OtherWallet222", MINT), 5000n);
  assert.strictEqual(t.getHoldings(WALLET, "OtherMint222"), 9000n);
}

// 7. Sequential partial sells each compute their fraction against the balance remaining AT THAT
//    POINT, not the original total — mirrors how a target repeatedly trimming a position should
//    make each of our own partial sells proportionally smaller too, not all sized off the start.
{
  const t = new TargetHoldingsTracker();
  t.recordBuy(WALLET, MINT, 1000);
  const first = t.recordSell(WALLET, MINT, 500); // 500 of 1000 remaining
  assert.ok(Math.abs(first - 0.5) < 1e-9, `expected 0.5, got ${first}`);
  assert.strictEqual(t.getHoldings(WALLET, MINT), 500n);
  const second = t.recordSell(WALLET, MINT, 250); // 250 of the 500 now remaining, not of the original 1000
  assert.ok(Math.abs(second - 0.5) < 1e-9, `expected 0.5, got ${second}`);
  assert.strictEqual(t.getHoldings(WALLET, MINT), 250n);
}

console.log("targetHoldings.test.ts: all assertions passed");
