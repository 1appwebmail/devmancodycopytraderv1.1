// Thin wrappers around the OFFICIAL pump.fun SDKs (@pump-fun/pump-sdk, @pump-fun/pump-swap-sdk)
// for actual instruction construction. This project used to hand-roll these instructions directly
// from the public IDL, but real-transaction testing (see project history) found the live program
// requires additional "remaining accounts" for an undocumented buyback/cashback fee mechanism that
// isn't in the public IDL at all — the IDL alone was not sufficient to build a working transaction.
// The official SDKs track this correctly (verified against real on-chain data: the bonding-curve
// SDK's hardcoded fee-recipient lists and PDA seeds matched real transactions exactly), so
// instruction construction is delegated to them entirely. This file keeps only the pieces that are
// genuinely ours to own: pump.fun's ATA handling (the SDK's raw buy/sell instruction builders
// don't include it) and PumpSwap's base/quote orientation resolution (a pool's SOL leg can be
// either base_mint or quote_mint — see WSOL_MINT's comment in constants.ts — and the SDK's
// buy/sell instructions are generic base/quote, not "token"-aware).
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { PUMP_SDK } from "@pump-fun/pump-sdk";
import { PUMP_AMM_SDK } from "@pump-fun/pump-swap-sdk";
import type { SwapSolanaState } from "@pump-fun/pump-swap-sdk";
import { WSOL_MINT } from "../constants.js";

function toBN(v: bigint): BN {
  return new BN(v.toString());
}

// The SDK's own getBuyInstructionRaw/getSellInstructionRaw default these to a random pick from
// their internal lists at the JS call-site (see @pump-fun/pump-sdk's bondingCurve.ts), but the
// package's exported .d.ts types mark both as required, and neither helper function is exported
// from the package's public API — so they're reimplemented here with the exact same address lists
// (cross-checked against live Global.fee_recipient + Global.fee_recipients[7] and
// Global.buyback_fee_recipients[8] on-chain data during this project's verification work; see
// src/live/verify_global_accounts.ts). Any entry in either list is a valid, currently-accepted
// recipient — the program doesn't require a specific one, just a real member of its own list.
const FEE_RECIPIENTS = [
  "62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV",
  "7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ",
  "7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX",
  "9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz",
  "AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY",
  "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM",
  "FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz",
  "G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP",
];
const BUYBACK_FEE_RECIPIENTS = [
  "5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD",
  "9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7",
  "GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL",
  "3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR",
  "5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6",
  "EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL",
  "5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD",
  "A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW",
];
function randomFeeRecipient(): PublicKey {
  return new PublicKey(FEE_RECIPIENTS[Math.floor(Math.random() * FEE_RECIPIENTS.length)]!);
}
function randomBuybackFeeRecipient(): PublicKey {
  return new PublicKey(BUYBACK_FEE_RECIPIENTS[Math.floor(Math.random() * BUYBACK_FEE_RECIPIENTS.length)]!);
}

// ---------- pump.fun (bonding curve) ----------

export interface PumpFunBuyParams {
  user: PublicKey;
  mint: PublicKey;
  creator: PublicKey; // bonding_curve.creator — caller must have already read this from the BondingCurve account
  tokenProgram: PublicKey;
  amountTokens: bigint; // exact token amount out (raw units)
  maxSolCostLamports: bigint; // slippage ceiling
}

export async function buildPumpFunBuyIx(p: PumpFunBuyParams): Promise<TransactionInstruction> {
  return PUMP_SDK.getBuyInstructionRaw({
    user: p.user,
    mint: p.mint,
    creator: p.creator,
    amount: toBN(p.amountTokens),
    solAmount: toBN(p.maxSolCostLamports),
    tokenProgram: p.tokenProgram,
    feeRecipient: randomFeeRecipient(),
    buybackFeeRecipient: randomBuybackFeeRecipient(),
  });
}

export interface PumpFunSellParams {
  user: PublicKey;
  mint: PublicKey;
  creator: PublicKey;
  tokenProgram: PublicKey;
  amountTokens: bigint; // exact token amount in (raw units)
  minSolOutputLamports: bigint; // slippage floor
  // BondingCurve.is_cashback_coin — REQUIRED whenever true: the live program rejects a sell with
  // InvalidCashbackAccumulator (error 6073) if this doesn't match, since it determines whether an
  // extra user_volume_accumulator account must be included (see @pump-fun/pump-sdk's
  // getSellInstructionInternal). Verified against a real failed transaction during live testing —
  // caller must read this from the actual bonding curve account, never assume false.
  cashback: boolean;
}

export async function buildPumpFunSellIx(p: PumpFunSellParams): Promise<TransactionInstruction> {
  return PUMP_SDK.getSellInstructionRaw({
    user: p.user,
    mint: p.mint,
    cashback: p.cashback,
    creator: p.creator,
    amount: toBN(p.amountTokens),
    solAmount: toBN(p.minSolOutputLamports),
    tokenProgram: p.tokenProgram,
    feeRecipient: randomFeeRecipient(),
    buybackFeeRecipient: randomBuybackFeeRecipient(),
  });
}

// ---------- PumpSwap (AMM pool) ----------

/** True if the pool's SOL leg is base_mint rather than quote_mint (the less common orientation). */
export function pumpSwapSolIsBase(state: SwapSolanaState): boolean {
  if (state.pool.quoteMint.toBase58() === WSOL_MINT) return false;
  if (state.pool.baseMint.toBase58() === WSOL_MINT) return true;
  throw new Error(`Pool ${state.poolKey.toBase58()} isn't SOL-denominated on either side (base=${state.pool.baseMint.toBase58()}, quote=${state.pool.quoteMint.toBase58()})`);
}

/**
 * Token-semantic "buy": spend up to `maxSolLamports` to acquire exactly `tokenAmountOut`. Only
 * supports the normal orientation (quote=SOL) — by far the common case for pump.fun-migrated
 * pools. Callers must check pumpSwapSolIsBase(state) first and handle/reject the inverted case
 * themselves; deliberately not auto-handled here (see src/executor/live.ts) since the inverted
 * case needs different amount semantics (the SDK's buy/sell are base/quote generic, not
 * "give up to X get exactly Y" in a fixed direction) and is rare enough not to be worth the risk
 * of a subtly-wrong implementation on a live-money path.
 */
export async function buildPumpSwapAcquireTokenIx(state: SwapSolanaState, tokenAmountOut: bigint, maxSolLamports: bigint): Promise<TransactionInstruction[]> {
  if (pumpSwapSolIsBase(state)) throw new Error("buildPumpSwapAcquireTokenIx: inverted-orientation pools (SOL=base) are not supported");
  return PUMP_AMM_SDK.buyInstructions(state, toBN(tokenAmountOut), toBN(maxSolLamports));
}

/** Token-semantic "sell": dispose of exactly `tokenAmountIn` for at least `minSolLamports`. Same
 *  normal-orientation-only restriction as buildPumpSwapAcquireTokenIx. */
export async function buildPumpSwapDisposeTokenIx(state: SwapSolanaState, tokenAmountIn: bigint, minSolLamports: bigint): Promise<TransactionInstruction[]> {
  if (pumpSwapSolIsBase(state)) throw new Error("buildPumpSwapDisposeTokenIx: inverted-orientation pools (SOL=base) are not supported");
  return PUMP_AMM_SDK.sellInstructions(state, toBN(tokenAmountIn), toBN(minSolLamports));
}
