import assert from "node:assert";
import { evaluateTrade, type StrategyState, type TradeContext } from "./strategy.js";
import { config } from "./config.js";
import type { FilterSettings } from "./settings.js";
import type { TradeEvent, Position } from "./types.js";

function filters(overrides: Partial<FilterSettings> = {}): FilterSettings {
  return {
    minMcapUsd: null,
    maxMcapUsd: null,
    minAgeSeconds: null,
    maxAgeSeconds: null,
    minTargetBuySol: null,
    maxTargetBuySol: null,
    ...overrides,
  };
}

const NO_CONTEXT: TradeContext = { mcapUsd: null, ageSeconds: null, sellFraction: null };
const NO_FILTERS = filters();

function trade(overrides: Partial<TradeEvent> = {}): TradeEvent {
  return {
    signature: "sig1",
    slot: 1,
    timestamp: Date.now() / 1000,
    venue: "pumpfun",
    direction: "buy",
    trader: "TargetWallet111",
    mint: "MintA111",
    solAmount: 1,
    tokenAmount: 1000,
    postSolReserves: 30_000_000_000n,
    postTokenReserves: 1_000_000_000_000n,
    ...overrides,
  };
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    id: "pos1",
    mint: "MintA111",
    venue: "pumpfun",
    openedAt: Date.now() / 1000,
    entrySolAmount: 0.5,
    entryTokenAmount: 500,
    entryPrice: 0.001,
    remainingTokenAmount: 500,
    realizedPnlSol: 0,
    status: "open",
    highWaterPrice: 0.001,
    ladderTiersHit: [],
    ...overrides,
  };
}

// 1. Fresh buy with no open positions -> copy buy
{
  const state: StrategyState = { openPositions: [] };
  const decision = evaluateTrade(trade(), state, NO_CONTEXT, NO_FILTERS);
  assert.deepStrictEqual(decision, { kind: "buy", mint: "MintA111", venue: "pumpfun", pool: undefined, solAmount: config.positionSizeSol, reason: "copy_buy" });
}

// 2. Buy on a mint we already hold -> skip (no pyramiding)
{
  const state: StrategyState = { openPositions: [position()] };
  const decision = evaluateTrade(trade({ mint: "MintA111" }), state, NO_CONTEXT, NO_FILTERS);
  assert.strictEqual(decision, null);
}

// 3. Buy when at max concurrent positions -> skip
{
  const state: StrategyState = {
    openPositions: Array.from({ length: config.maxConcurrentPositions }, (_, i) => position({ id: `p${i}`, mint: `Mint${i}` })),
  };
  const decision = evaluateTrade(trade({ mint: "MintNew" }), state, NO_CONTEXT, NO_FILTERS);
  assert.strictEqual(decision, null);
}

// 4. Sell on a mint we hold -> copy sell, full exit when sellFraction is unknown (null)
{
  const state: StrategyState = { openPositions: [position()] };
  const decision = evaluateTrade(trade({ direction: "sell", mint: "MintA111" }), state, NO_CONTEXT, NO_FILTERS);
  assert.deepStrictEqual(decision, { kind: "sell", positionId: "pos1", reason: "copy_sell", fraction: 1 });
}

// 5. Sell on a mint we don't hold -> skip
{
  const state: StrategyState = { openPositions: [] };
  const decision = evaluateTrade(trade({ direction: "sell", mint: "MintB222" }), state, NO_CONTEXT, NO_FILTERS);
  assert.strictEqual(decision, null);
}

// 6. Mcap filter: within [min, max] -> buy allowed
{
  const state: StrategyState = { openPositions: [] };
  const decision = evaluateTrade(trade(), state, { mcapUsd: 50, ageSeconds: null, sellFraction: null }, filters({ minMcapUsd: 10, maxMcapUsd: 100 }));
  assert.ok(decision && decision.kind === "buy");
}

// 7. Mcap filter: below min -> skip
{
  const state: StrategyState = { openPositions: [] };
  const decision = evaluateTrade(trade(), state, { mcapUsd: 5, ageSeconds: null, sellFraction: null }, filters({ minMcapUsd: 10, maxMcapUsd: 100 }));
  assert.strictEqual(decision, null);
}

// 8. Mcap filter: above max -> skip
{
  const state: StrategyState = { openPositions: [] };
  const decision = evaluateTrade(trade(), state, { mcapUsd: 500, ageSeconds: null, sellFraction: null }, filters({ minMcapUsd: 10, maxMcapUsd: 100 }));
  assert.strictEqual(decision, null);
}

// 9. Mcap filter active but mcap couldn't be resolved (null) -> skip, don't silently ignore the filter
{
  const state: StrategyState = { openPositions: [] };
  const decision = evaluateTrade(trade(), state, { mcapUsd: null, ageSeconds: null, sellFraction: null }, filters({ minMcapUsd: 10, maxMcapUsd: 100 }));
  assert.strictEqual(decision, null);
}

// 10. Age filter: within [min, max] -> buy allowed
{
  const state: StrategyState = { openPositions: [] };
  const decision = evaluateTrade(trade(), state, { mcapUsd: null, ageSeconds: 120, sellFraction: null }, filters({ minAgeSeconds: 30, maxAgeSeconds: 600 }));
  assert.ok(decision && decision.kind === "buy");
}

// 11. Age filter: too young -> skip
{
  const state: StrategyState = { openPositions: [] };
  const decision = evaluateTrade(trade(), state, { mcapUsd: null, ageSeconds: 5, sellFraction: null }, filters({ minAgeSeconds: 30, maxAgeSeconds: 600 }));
  assert.strictEqual(decision, null);
}

// 12. Age filter: too old -> skip
{
  const state: StrategyState = { openPositions: [] };
  const decision = evaluateTrade(trade(), state, { mcapUsd: null, ageSeconds: 9999, sellFraction: null }, filters({ minAgeSeconds: 30, maxAgeSeconds: 600 }));
  assert.strictEqual(decision, null);
}

// 13. Sells are never filtered by mcap/age/target-buy-size, even if a position is somehow missing context
{
  const state: StrategyState = { openPositions: [position()] };
  const decision = evaluateTrade(
    trade({ direction: "sell", mint: "MintA111" }),
    state,
    NO_CONTEXT,
    filters({ minMcapUsd: 10, maxMcapUsd: 100, minAgeSeconds: 30, maxAgeSeconds: 600, minTargetBuySol: 1, maxTargetBuySol: 5 }),
  );
  assert.deepStrictEqual(decision, { kind: "sell", positionId: "pos1", reason: "copy_sell", fraction: 1 });
}

// 13b. Partial copy-sell: sellFraction from context flows straight into the Decision, so a target
// selling e.g. 30% of their tracked holdings sells 30% of OUR position, not the whole thing
{
  const state: StrategyState = { openPositions: [position()] };
  const decision = evaluateTrade(trade({ direction: "sell", mint: "MintA111" }), state, { mcapUsd: null, ageSeconds: null, sellFraction: 0.3 }, NO_FILTERS);
  assert.deepStrictEqual(decision, { kind: "sell", positionId: "pos1", reason: "copy_sell", fraction: 0.3 });
}

// 13c. Full copy-sell: sellFraction of 1 (target sold their entire tracked position) exits fully
{
  const state: StrategyState = { openPositions: [position()] };
  const decision = evaluateTrade(trade({ direction: "sell", mint: "MintA111" }), state, { mcapUsd: null, ageSeconds: null, sellFraction: 1 }, NO_FILTERS);
  assert.deepStrictEqual(decision, { kind: "sell", positionId: "pos1", reason: "copy_sell", fraction: 1 });
}

// 14. Target buy size filter: tiny "chart support" buy below min -> skip
{
  const state: StrategyState = { openPositions: [] };
  const decision = evaluateTrade(trade({ solAmount: 0.001 }), state, NO_CONTEXT, filters({ minTargetBuySol: 0.05 }));
  assert.strictEqual(decision, null);
}

// 15. Target buy size filter: within [min, max] -> buy allowed
{
  const state: StrategyState = { openPositions: [] };
  const decision = evaluateTrade(trade({ solAmount: 1 }), state, NO_CONTEXT, filters({ minTargetBuySol: 0.05, maxTargetBuySol: 10 }));
  assert.ok(decision && decision.kind === "buy");
}

// 16. Target buy size filter: whale buy above max -> skip
{
  const state: StrategyState = { openPositions: [] };
  const decision = evaluateTrade(trade({ solAmount: 50 }), state, NO_CONTEXT, filters({ minTargetBuySol: 0.05, maxTargetBuySol: 10 }));
  assert.strictEqual(decision, null);
}

// 17. Target buy size filter needs no context/RPC resolution — active immediately, unlike mcap/age
{
  const state: StrategyState = { openPositions: [] };
  const decision = evaluateTrade(trade({ solAmount: 0.0005 }), state, NO_CONTEXT, filters({ minTargetBuySol: 0.05 }));
  assert.strictEqual(decision, null);
}

console.log("strategy.test.ts: all assertions passed");
