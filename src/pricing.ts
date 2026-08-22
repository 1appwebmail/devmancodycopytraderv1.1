// Both Pump.fun's bonding curve and PumpSwap's AMM are constant-product
// (x*y=k) markets with a fee taken on the input side. This is a close
// approximation for paper-trading purposes; it doesn't model the exact
// protocol/creator/lp fee split (see FeeConfig on-chain), just a flat
// approximate fee in basis points.
export function constantProductSwapOut(reserveIn: bigint, reserveOut: bigint, amountIn: bigint, feeBps: number): bigint {
  if (amountIn <= 0n) return 0n;
  const amountInAfterFee = (amountIn * BigInt(10_000 - feeBps)) / 10_000n;
  const denominator = reserveIn + amountInAfterFee;
  if (denominator <= 0n) return 0n;
  return (amountInAfterFee * reserveOut) / denominator;
}

export function priceSolPerToken(solReserves: bigint, tokenReserves: bigint): number {
  if (tokenReserves === 0n) return 0;
  return Number(solReserves) / Number(tokenReserves);
}

/** Fully-diluted market cap in SOL, given a SOL-per-raw-token price (not lamports) and the mint's raw total supply. */
export function marketCapSol(solPerRawToken: number, totalSupplyRaw: bigint): number {
  return solPerRawToken * Number(totalSupplyRaw);
}
