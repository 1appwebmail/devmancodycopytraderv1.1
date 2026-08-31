import { randomUUID } from "node:crypto";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { OnlinePumpAmmSdk } from "@pump-fun/pump-swap-sdk";
import { config } from "../config.js";
import { constantProductSwapOut, priceSolPerToken } from "../pricing.js";
import { LAMPORTS_PER_SOL, NATIVE_SOL_SENTINEL } from "../constants.js";
import { decodeStruct } from "../parsing/borsh.js";
import { BondingCurveAccountSchema } from "../parsing/schemas.js";
import { deriveBondingCurve } from "../live/pda.js";
import { resolveTokenProgram, createAtaIdempotentIx } from "../live/ata.js";
import { buildPumpFunBuyIx, buildPumpFunSellIx, buildPumpSwapAcquireTokenIx, buildPumpSwapDisposeTokenIx, pumpSwapSolIsBase } from "../live/instructions.js";
import { buildSignAndSubmit } from "../live/submit.js";
import { parseOwnFill } from "../live/parseFill.js";
import { withRetry } from "../pricing/withRetry.js";
import type { Position, TradeLogEntry, Venue } from "../types.js";
import type { Reserves, PaperState } from "./paper.js";

const ANCHOR_ACCOUNT_DISCRIMINATOR_LEN = 8;

async function fetchBondingCurveFull(connection: Connection, mint: PublicKey) {
  const info = await withRetry(() => connection.getAccountInfo(deriveBondingCurve(mint)));
  if (!info) return null;
  return decodeStruct<{ creator: string; quote_mint: string; complete: boolean; is_cashback_coin: boolean }>(
    info.data.subarray(ANCHOR_ACCOUNT_DISCRIMINATOR_LEN),
    BondingCurveAccountSchema,
  );
}

/**
 * Real on-chain counterpart to PaperExecutor, same public shape (buy/sell/getState) so App.ts and
 * PositionMonitor can use either one behind an identical interface — the only difference from the
 * caller's perspective is that buy/sell now do real signing/submission and can take seconds and
 * fail for on-chain reasons (insufficient funds, slippage exceeded, dead curve, etc), not just
 * return null for a paper-side balance check.
 *
 * Every buy/sell is preceded by hard safety-cap checks (config.live.*) — these run BEFORE any
 * transaction is built or submitted, so a misconfigured strategy can never spend more than the
 * user explicitly capped, independent of whatever POSITION_SIZE_SOL/MAX_CONCURRENT_POSITIONS say.
 *
 * Instruction construction is delegated to the official @pump-fun/pump-sdk and
 * @pump-fun/pump-swap-sdk packages (see src/live/instructions.ts for why) — this class only
 * decides HOW MUCH to trade (reserve-based estimate + slippage, reusing the same math
 * PaperExecutor uses) and handles the buy/sell/Position/TradeLogEntry bookkeeping around it.
 */
export class LiveExecutor {
  private balanceLamports = 0n;
  private positions: Position[] = [];
  private trades: TradeLogEntry[] = [];
  private ammSdk: OnlinePumpAmmSdk;

  constructor(
    private connection: Connection,
    private payer: Keypair,
    initialState?: PaperState,
  ) {
    this.ammSdk = new OnlinePumpAmmSdk(connection);
    if (initialState) {
      this.positions = initialState.positions;
      this.trades = initialState.trades;
    }
  }

  async refreshBalance(): Promise<void> {
    this.balanceLamports = BigInt(await withRetry(() => this.connection.getBalance(this.payer.publicKey)));
  }

  private solAtRiskLamports(): bigint {
    return this.positions
      .filter((p) => p.status === "open")
      .reduce((sum, p) => sum + BigInt(Math.round(p.entrySolAmount * LAMPORTS_PER_SOL)), 0n);
  }

  async buy(mint: string, venue: Venue, solAmount: number, reserves: Reserves, pool?: string): Promise<Position | null> {
    const solLamports = BigInt(Math.round(solAmount * LAMPORTS_PER_SOL));
    if (solLamports <= 0n) return null;

    // --- hard safety rails, checked before touching the network ---
    if (solAmount > config.live.maxPositionSol) {
      console.error(`[live] buy blocked: ${solAmount} SOL exceeds LIVE_MAX_POSITION_SOL=${config.live.maxPositionSol}`);
      return null;
    }
    if (this.solAtRiskLamports() + solLamports > BigInt(Math.round(config.live.maxTotalSolAtRisk * LAMPORTS_PER_SOL))) {
      console.error(`[live] buy blocked: would exceed LIVE_MAX_TOTAL_SOL_AT_RISK=${config.live.maxTotalSolAtRisk} SOL`);
      return null;
    }
    const reserveLamports = BigInt(Math.round(config.live.minSolReserve * LAMPORTS_PER_SOL));
    if (this.balanceLamports - solLamports < reserveLamports) {
      console.error(`[live] buy blocked: insufficient balance (have ${Number(this.balanceLamports) / LAMPORTS_PER_SOL} SOL, need ${solAmount} + ${config.live.minSolReserve} reserve)`);
      return null;
    }

    const expectedTokensOut = constantProductSwapOut(reserves.sol, reserves.token, solLamports, config.paperFeeBps);
    if (expectedTokensOut <= 0n) return null;
    const amountTokens = (expectedTokensOut * BigInt(10000 - config.live.slippageBps)) / 10000n;
    if (amountTokens <= 0n) return null;

    const mintPk = new PublicKey(mint);
    let fill: { solLamports: bigint; tokenAmount: bigint } | null = null;
    let signature: string;

    try {
      if (venue === "pumpfun") {
        const curve = await fetchBondingCurveFull(this.connection, mintPk);
        if (!curve || curve.complete) {
          console.error(`[live] buy blocked: bonding curve for ${mint} is missing or already complete`);
          return null;
        }
        if (curve.quote_mint !== NATIVE_SOL_SENTINEL) {
          console.error(`[live] buy blocked: ${mint}'s bonding curve isn't native-SOL-quoted (quote_mint=${curve.quote_mint}) — unsupported`);
          return null;
        }
        const tokenProgram = await resolveTokenProgram(this.connection, mintPk);
        const ixs = [
          createAtaIdempotentIx(this.payer.publicKey, mintPk, tokenProgram, this.payer.publicKey),
          await buildPumpFunBuyIx({
            user: this.payer.publicKey,
            mint: mintPk,
            creator: new PublicKey(curve.creator),
            tokenProgram,
            amountTokens,
            maxSolCostLamports: solLamports,
          }),
        ];
        const result = await buildSignAndSubmit(this.connection, this.payer, ixs, {
          computeUnitLimit: config.live.computeUnitLimit,
          computeUnitPriceMicroLamports: config.live.computeUnitPriceMicroLamports,
          confirmTimeoutMs: config.live.confirmTimeoutMs,
        });
        if (!result.confirmed) {
          console.error(`[live] buy failed for ${mint}: ${result.error} (sig ${result.signature})`);
          return null;
        }
        signature = result.signature;
        fill = await parseOwnFill(this.connection, signature, "pumpfun", "buy");
      } else {
        if (!pool) return null;
        const poolKey = new PublicKey(pool);
        const state = await this.ammSdk.swapSolanaState(poolKey, this.payer.publicKey);
        const solIsBase = pumpSwapSolIsBase(state);
        if (solIsBase) {
          console.error(`[live] buy blocked: pool ${pool} has SOL as base_mint (inverted orientation) — not supported yet`);
          return null;
        }
        const ixs = await buildPumpSwapAcquireTokenIx(state, amountTokens, solLamports);
        const result = await buildSignAndSubmit(this.connection, this.payer, ixs, {
          computeUnitLimit: config.live.computeUnitLimit,
          computeUnitPriceMicroLamports: config.live.computeUnitPriceMicroLamports,
          confirmTimeoutMs: config.live.confirmTimeoutMs,
        });
        if (!result.confirmed) {
          console.error(`[live] buy failed for ${mint}: ${result.error} (sig ${result.signature})`);
          return null;
        }
        signature = result.signature;
        fill = await parseOwnFill(this.connection, signature, "pumpswap", "buy", solIsBase);
      }
    } catch (err) {
      console.error(`[live] buy threw for ${mint}:`, err);
      return null;
    }

    await this.refreshBalance();
    const actualSolLamports = fill?.solLamports ?? solLamports;
    const actualTokens = fill?.tokenAmount ?? amountTokens;
    const actualSolAmount = Number(actualSolLamports) / LAMPORTS_PER_SOL;
    const entryPrice = priceSolPerToken(actualSolLamports, actualTokens);

    const position: Position = {
      id: randomUUID(),
      mint,
      venue,
      pool,
      openedAt: Date.now() / 1000,
      entrySolAmount: actualSolAmount,
      entryTokenAmount: Number(actualTokens),
      entryPrice,
      remainingTokenAmount: Number(actualTokens),
      realizedPnlSol: 0,
      status: "open",
      highWaterPrice: entryPrice,
      ladderTiersHit: [],
    };
    this.positions.push(position);
    this.trades.push({
      timestamp: position.openedAt,
      positionId: position.id,
      mint,
      venue,
      direction: "buy",
      solAmount: actualSolAmount,
      tokenAmount: Number(actualTokens),
      price: entryPrice,
      reason: "copy_buy",
    });
    console.log(`[live] BUY confirmed ${mint.slice(0, 8)}… sig=${signature}`);
    return position;
  }

  // Guards against a real race that surfaced in live testing: copy_sell (target wallet sells),
  // a manual UI close, and the position monitor's own exit rules (stop-loss/take-profit/etc.) can
  // all independently call sell() for the same position around the same moment. Since each reads
  // remainingTokenAmount from in-memory state (only updated AFTER an async on-chain sell actually
  // lands), two concurrent calls would both try to sell the full remaining balance — the first to
  // land succeeds, the second fails on-chain with NotEnoughTokensToSell (wastes a tx fee, no funds
  // lost, but noisy and wasteful). This lock makes the second caller bail out immediately instead.
  private pendingSells = new Set<string>();

  async sell(positionId: string, reserves: Reserves, reason: Position["exitReason"], fraction = 1): Promise<TradeLogEntry | null> {
    if (this.pendingSells.has(positionId)) {
      console.error(`[live] sell blocked: a sell for position ${positionId} is already in flight`);
      return null;
    }
    this.pendingSells.add(positionId);
    try {
      return await this.sellInternal(positionId, reserves, reason, fraction);
    } finally {
      this.pendingSells.delete(positionId);
    }
  }

  private async sellInternal(positionId: string, reserves: Reserves, reason: Position["exitReason"], fraction = 1): Promise<TradeLogEntry | null> {
    const position = this.positions.find((p) => p.id === positionId && p.status === "open");
    if (!position) return null;

    const tokensToSell = BigInt(Math.round(position.remainingTokenAmount * Math.min(1, Math.max(0, fraction))));
    if (tokensToSell <= 0n) return null;

    const expectedSolOut = constantProductSwapOut(reserves.token, reserves.sol, tokensToSell, config.paperFeeBps);
    const minSolOutputLamports = (expectedSolOut * BigInt(10000 - config.live.slippageBps)) / 10000n;

    const mintPk = new PublicKey(position.mint);
    let fill: { solLamports: bigint; tokenAmount: bigint } | null = null;
    let signature: string;

    try {
      if (position.venue === "pumpfun") {
        const curve = await fetchBondingCurveFull(this.connection, mintPk);
        if (!curve) {
          console.error(`[live] sell blocked: bonding curve for ${position.mint} not found`);
          return null;
        }
        const tokenProgram = await resolveTokenProgram(this.connection, mintPk);
        const ix = await buildPumpFunSellIx({
          user: this.payer.publicKey,
          mint: mintPk,
          creator: new PublicKey(curve.creator),
          tokenProgram,
          amountTokens: tokensToSell,
          minSolOutputLamports,
          cashback: curve.is_cashback_coin,
        });
        const result = await buildSignAndSubmit(this.connection, this.payer, [ix], {
          computeUnitLimit: config.live.computeUnitLimit,
          computeUnitPriceMicroLamports: config.live.computeUnitPriceMicroLamports,
          confirmTimeoutMs: config.live.confirmTimeoutMs,
        });
        if (!result.confirmed) {
          console.error(`[live] sell failed for ${position.mint}: ${result.error} (sig ${result.signature})`);
          return null;
        }
        signature = result.signature;
        fill = await parseOwnFill(this.connection, signature, "pumpfun", "sell");
      } else {
        if (!position.pool) return null;
        const poolKey = new PublicKey(position.pool);
        const state = await this.ammSdk.swapSolanaState(poolKey, this.payer.publicKey);
        const solIsBase = pumpSwapSolIsBase(state);
        if (solIsBase) {
          console.error(`[live] sell blocked: pool ${position.pool} has SOL as base_mint (inverted orientation) — not supported yet`);
          return null;
        }
        const ixs = await buildPumpSwapDisposeTokenIx(state, tokensToSell, minSolOutputLamports);
        const result = await buildSignAndSubmit(this.connection, this.payer, ixs, {
          computeUnitLimit: config.live.computeUnitLimit,
          computeUnitPriceMicroLamports: config.live.computeUnitPriceMicroLamports,
          confirmTimeoutMs: config.live.confirmTimeoutMs,
        });
        if (!result.confirmed) {
          console.error(`[live] sell failed for ${position.mint}: ${result.error} (sig ${result.signature})`);
          return null;
        }
        signature = result.signature;
        fill = await parseOwnFill(this.connection, signature, "pumpswap", "sell", solIsBase);
      }
    } catch (err) {
      console.error(`[live] sell threw for ${position.mint}:`, err);
      return null;
    }

    await this.refreshBalance();
    const actualSolLamports = fill?.solLamports ?? minSolOutputLamports;
    const actualTokensSold = fill?.tokenAmount ?? tokensToSell;
    const solOut = Number(actualSolLamports) / LAMPORTS_PER_SOL;

    const costBasisPerToken = position.entrySolAmount / position.entryTokenAmount;
    const realizedPnl = solOut - costBasisPerToken * Number(actualTokensSold);

    position.remainingTokenAmount -= Number(actualTokensSold);
    position.realizedPnlSol += realizedPnl;

    const fullyClosed = position.remainingTokenAmount <= 0;
    if (fullyClosed) {
      position.status = "closed";
      position.closedAt = Date.now() / 1000;
      position.exitReason = reason;
    }

    const entry: TradeLogEntry = {
      timestamp: Date.now() / 1000,
      positionId: position.id,
      mint: position.mint,
      venue: position.venue,
      direction: "sell",
      solAmount: solOut,
      tokenAmount: Number(actualTokensSold),
      price: priceSolPerToken(actualSolLamports, actualTokensSold),
      reason: reason ?? "manual",
    };
    this.trades.push(entry);
    console.log(`[live] SELL confirmed ${position.mint.slice(0, 8)}… sig=${signature}`);
    return entry;
  }

  getState(): PaperState {
    return {
      balanceSol: Number(this.balanceLamports) / LAMPORTS_PER_SOL,
      positions: this.positions,
      trades: this.trades,
    };
  }
}
