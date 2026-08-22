import assert from "node:assert";
import { checkExitConditions, computeUnrealizedPnl, checkLadderTiers } from "./positionManager.js";
import { config, type LadderTier } from "./config.js";
import { LAMPORTS_PER_SOL } from "./constants.js";
import type { Position } from "./types.js";

function position(overrides: Partial<Position> = {}): Position {
  return {
    id: "pos1",
    mint: "MintA",
    venue: "pumpfun",
    openedAt: Date.now() / 1000,
    entrySolAmount: 1,
    entryTokenAmount: 1000,
    entryPrice: 0.001, // 1 SOL / 1000 tokens
    remainingTokenAmount: 1000,
    realizedPnlSol: 0,
    status: "open",
    highWaterPrice: 0.001,
    ladderTiersHit: [],
    ...overrides,
  };
}

// Prices are derived from the running config's actual thresholds (not hardcoded percentages)
// so this test doesn't silently break whenever .env changes stop-loss/take-profit/trailing values.
// A small margin past/before each threshold avoids floating-point boundary flakiness
// at the exact percentage (e.g. computing -25.000000000000004% vs -25%).
const MARGIN = 0.5; // percentage points
const ENTRY = 0.001;
const stopLossPriceBreached = ENTRY * (1 - (config.stopLossPct + MARGIN) / 100);
const stopLossPriceSafe = ENTRY * (1 - (config.stopLossPct - MARGIN) / 100);
const takeProfitPriceBreached = ENTRY * (1 + (config.takeProfitPct + MARGIN) / 100);

// 1. Price unchanged -> no exit
assert.strictEqual(checkExitConditions(position(), ENTRY), null);

// 2. Price past the stop-loss threshold -> stop loss
assert.strictEqual(checkExitConditions(position(), stopLossPriceBreached), "stop_loss");

// 3. Price just short of the stop-loss threshold -> still holding
assert.strictEqual(checkExitConditions(position(), stopLossPriceSafe), null);

// 4. Price past the take-profit threshold -> take profit
assert.strictEqual(checkExitConditions(position(), takeProfitPriceBreached), "take_profit");

// 5. Price ran up to a new high water mark then dropped by the trailing-stop threshold from
//    that peak -> trailing stop, even though it's still above entry price
{
  const peak = ENTRY * 2;
  const p = position({ highWaterPrice: peak });
  const priceDownFromPeak = peak * (1 - (config.trailingStopPct + MARGIN) / 100);
  assert.strictEqual(checkExitConditions(p, priceDownFromPeak), "trailing_stop");
}

// 6. Trailing stop should not fire if price never moved above entry (highWaterPrice === entryPrice),
//    as long as the resulting drawdown from entry doesn't also cross the stop-loss threshold
{
  const p = position({ highWaterPrice: ENTRY });
  const safeDipPct = Math.min(config.stopLossPct, config.trailingStopPct) / 2; // guaranteed under both thresholds
  const smallDip = ENTRY * (1 - safeDipPct / 100);
  assert.strictEqual(checkExitConditions(p, smallDip), null);
}

// computeUnrealizedPnl takes `currentPrice` in lamports/raw-token (matching Position.entryPrice's
// real units, from priceSolPerToken) — NOT the same scale as entrySolAmount, which is human SOL.
// Use realistic magnitudes here so a units bug (e.g. forgetting to divide by LAMPORTS_PER_SOL)
// actually shows up as a failure instead of being masked by toy numbers.
function pnlPosition(overrides: Partial<Position> = {}): Position {
  const entryTokenAmount = 1_000_000;
  const entrySolAmount = 1;
  const entryPrice = (entrySolAmount * LAMPORTS_PER_SOL) / entryTokenAmount; // lamports/raw-token
  return position({ entrySolAmount, entryTokenAmount, entryPrice, remainingTokenAmount: entryTokenAmount, ...overrides });
}

// 7. computeUnrealizedPnl: price doubled on the full remaining position -> 1 SOL unrealized profit, +100%
{
  const p = pnlPosition();
  const result = computeUnrealizedPnl(p, p.entryPrice * 2);
  assert.ok(Math.abs(result.unrealizedPnlSol - 1) < 1e-6, `expected ~1 SOL profit, got ${result.unrealizedPnlSol}`);
  assert.ok(Math.abs(result.unrealizedPnlPct - 100) < 1e-6, `expected ~100%, got ${result.unrealizedPnlPct}`);
}

// 8. computeUnrealizedPnl: after partially selling, PnL is based on the remaining tokens only
{
  const p = pnlPosition({ remainingTokenAmount: 500_000 }); // half sold already
  const result = computeUnrealizedPnl(p, p.entryPrice * 2);
  assert.ok(Math.abs(result.unrealizedPnlSol - 0.5) < 1e-6, `expected ~0.5 SOL profit on remaining half, got ${result.unrealizedPnlSol}`);
}

// 8b. computeUnrealizedPnl: USD figure is just the SOL PnL times the given SOL/USD price; null when no price is available
{
  const p = pnlPosition();
  const withPrice = computeUnrealizedPnl(p, p.entryPrice * 2, 150);
  assert.ok(withPrice.unrealizedPnlUsd !== null && Math.abs(withPrice.unrealizedPnlUsd - 150) < 1e-4, `expected ~$150 (1 SOL * $150), got ${withPrice.unrealizedPnlUsd}`);
  const withoutPrice = computeUnrealizedPnl(p, p.entryPrice * 2);
  assert.strictEqual(withoutPrice.unrealizedPnlUsd, null);
}

// 9. computeUnrealizedPnl: price unchanged -> ~0 PnL (regression guard for the lamports/SOL unit bug —
//    this would have reported billions of SOL in profit before the fix)
{
  const p = pnlPosition();
  const result = computeUnrealizedPnl(p, p.entryPrice);
  assert.ok(Math.abs(result.unrealizedPnlSol) < 1e-6, `expected ~0 SOL PnL at unchanged price, got ${result.unrealizedPnlSol}`);
}

// checkLadderTiers: sell 25% of the ORIGINAL position at +50%, another 25% at +100%
const LADDER: LadderTier[] = [
  { pct: 50, fraction: 0.25 },
  { pct: 100, fraction: 0.25 },
];

// 10. No tiers configured -> laddering never fires, regardless of price
{
  const p = pnlPosition();
  assert.strictEqual(checkLadderTiers(p, p.entryPrice * 10, []), null);
}

// 11. Price hasn't reached the first tier yet -> no sell
{
  const p = pnlPosition();
  assert.strictEqual(checkLadderTiers(p, p.entryPrice * 1.2, LADDER), null); // +20%, tier 0 needs +50%
}

// 12. Price crosses the first tier only -> sells 25% of the original position
{
  const p = pnlPosition(); // 1,000,000 raw tokens, all still remaining
  const result = checkLadderTiers(p, p.entryPrice * 1.6, LADDER); // +60%, past tier 0 (50%) but not tier 1 (100%)
  assert.ok(result, "expected tier 0 to fire");
  assert.deepStrictEqual(result.tierIndexes, [0]);
  assert.ok(Math.abs(result.fractionOfRemaining - 0.25) < 1e-9, `expected fractionOfRemaining ~0.25, got ${result.fractionOfRemaining}`);
}

// 13. A tier already marked as hit never fires again, even if price is still above its threshold
{
  const p = pnlPosition({ ladderTiersHit: [0] });
  const result = checkLadderTiers(p, p.entryPrice * 1.6, LADDER);
  assert.strictEqual(result, null);
}

// 14. Price gaps past BOTH tiers between polls (e.g. a fast pump) -> both fire together in one
//     combined sell instead of the second one being silently skipped
{
  const p = pnlPosition();
  const result = checkLadderTiers(p, p.entryPrice * 3, LADDER); // +200%, past both tier 0 (50%) and tier 1 (100%)
  assert.ok(result, "expected both tiers to fire");
  assert.deepStrictEqual(result.tierIndexes.sort(), [0, 1]);
  assert.ok(Math.abs(result.fractionOfRemaining - 0.5) < 1e-9, `expected fractionOfRemaining ~0.5 (25%+25% of original), got ${result.fractionOfRemaining}`);
}

// 15. Fractions are of the ORIGINAL position, so after tier 0 already sold some tokens, tier 1's
//     fraction-of-remaining is proportionally larger against the smaller remaining balance
{
  const p = pnlPosition({ ladderTiersHit: [0], remainingTokenAmount: 750_000 }); // tier 0 already sold 25% of the original 1,000,000
  const result = checkLadderTiers(p, p.entryPrice * 3, LADDER);
  assert.ok(result);
  assert.deepStrictEqual(result.tierIndexes, [1]);
  // tier 1 wants to sell 25% of the ORIGINAL 1,000,000 = 250,000 tokens, which is 1/3 of the 750,000 remaining
  assert.ok(Math.abs(result.fractionOfRemaining - 1 / 3) < 1e-6, `expected ~0.333, got ${result.fractionOfRemaining}`);
}

console.log("positionManager.test.ts: all assertions passed");
