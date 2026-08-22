import assert from "node:assert";
import { PaperExecutor, type Reserves } from "./paper.js";

const reserves: Reserves = { sol: 30_000_000_000n, token: 1_000_000_000_000n }; // 30 SOL / 1e12 tokens

// 1. Buy math matches independently-computed constant-product formula (feeBps=100 from default config/.env fallback)
{
  const exec = new PaperExecutor(10);
  const position = exec.buy("MintA", "pumpfun", 1, reserves);
  assert.ok(position, "buy should succeed with sufficient balance");

  const feeBps = 100n;
  const solLamports = 1_000_000_000n;
  const amountInAfterFee = (solLamports * (10_000n - feeBps)) / 10_000n;
  const expectedTokensOut = (amountInAfterFee * reserves.token) / (reserves.sol + amountInAfterFee);
  assert.strictEqual(BigInt(position!.entryTokenAmount), expectedTokensOut);

  const state = exec.getState();
  assert.ok(Math.abs(state.balanceSol - 9) < 1e-9, `balance should be ~9 SOL, got ${state.balanceSol}`);
}

// 2. Insufficient balance -> buy returns null, balance unchanged
{
  const exec = new PaperExecutor(0.1);
  const position = exec.buy("MintA", "pumpfun", 1, reserves);
  assert.strictEqual(position, null);
  assert.strictEqual(exec.getState().balanceSol, 0.1);
}

// 3. Partial sell reduces remaining tokens but keeps position open
{
  const exec = new PaperExecutor(10);
  const position = exec.buy("MintA", "pumpfun", 1, reserves)!;
  const sellEntry = exec.sell(position.id, reserves, "manual", 0.5);
  assert.ok(sellEntry);
  const updated = exec.getState().positions.find((p) => p.id === position.id)!;
  assert.strictEqual(updated.status, "open");
  assert.ok(updated.remainingTokenAmount < position.entryTokenAmount);
  assert.ok(updated.remainingTokenAmount > 0);
}

// 4. Full sell closes the position and balance reflects proceeds
{
  const exec = new PaperExecutor(10);
  const position = exec.buy("MintA", "pumpfun", 1, reserves)!;
  const balanceAfterBuy = exec.getState().balanceSol;
  const sellEntry = exec.sell(position.id, reserves, "take_profit", 1)!;
  const updated = exec.getState().positions.find((p) => p.id === position.id)!;
  assert.strictEqual(updated.status, "closed");
  assert.strictEqual(updated.remainingTokenAmount, 0);
  assert.strictEqual(updated.exitReason, "take_profit");
  const balanceAfterSell = exec.getState().balanceSol;
  assert.ok(Math.abs(balanceAfterSell - (balanceAfterBuy + sellEntry.solAmount)) < 1e-9);
}

// 5. Selling a non-existent/closed position returns null
{
  const exec = new PaperExecutor(10);
  assert.strictEqual(exec.sell("nonexistent", reserves, "manual"), null);
}

console.log("paper.test.ts: all assertions passed");
