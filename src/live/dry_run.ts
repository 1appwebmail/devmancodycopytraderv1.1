// Validates the entire live-execution pipeline (account resolution, instruction construction via
// the official @pump-fun SDKs, ATA handling) against REAL on-chain state using
// connection.simulateTransaction — no SOL is spent, no transaction is ever broadcast. Run this as
// many times as you want before your scheduled live window; a clean simulation here is the
// strongest signal short of an actual fill that a real submission will work.
//
// Usage:
//   npx tsx src/live/dry_run.ts <mint> [solAmount]
//
// <mint>      a REAL pump.fun mint currently live (either still bonding-curve or already migrated
//             to PumpSwap) — grab one from your own bot's logs, pump.fun's site, or Solscan.
// [solAmount] how much SOL to simulate spending (default 0.05, matching your planned live test size)
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { OnlinePumpAmmSdk } from "@pump-fun/pump-swap-sdk";
import { config } from "../config.js";
import { constantProductSwapOut } from "../pricing.js";
import { LAMPORTS_PER_SOL, NATIVE_SOL_SENTINEL } from "../constants.js";
import { decodeStruct } from "../parsing/borsh.js";
import { BondingCurveAccountSchema } from "../parsing/schemas.js";
import { deriveBondingCurve } from "./pda.js";
import { resolveTokenProgram, createAtaIdempotentIx } from "./ata.js";
import { buildPumpFunBuyIx, buildPumpSwapAcquireTokenIx, pumpSwapSolIsBase } from "./instructions.js";
import { loadLiveKeypair } from "./keys.js";
import { findPumpSwapPoolForMint } from "../pricing/liveReserves.js";
import { withRetry } from "../pricing/withRetry.js";

const ANCHOR_ACCOUNT_DISCRIMINATOR_LEN = 8;

async function main() {
  const mintArg = process.argv[2];
  const solAmount = Number(process.argv[3] || config.live.maxPositionSol || "0.05");
  if (!mintArg) {
    console.error("Usage: npx tsx src/live/dry_run.ts <mint> [solAmount]");
    process.exit(1);
  }

  const connection = new Connection(config.rpcHttpUrl, "confirmed");
  const mint = new PublicKey(mintArg);

  let payer: Keypair;
  try {
    payer = loadLiveKeypair();
  } catch (err) {
    console.error("Could not load LIVE_PRIVATE_KEY — set it in .env even for a dry run, since simulation needs a real fee payer to check balance/ownership against:", err);
    process.exit(1);
  }
  console.log(`Simulating a ${solAmount} SOL buy of ${mint.toBase58()} as ${payer.publicKey.toBase58()}\n`);

  const balanceLamports = await withRetry(() => connection.getBalance(payer.publicKey));
  console.log(`Wallet balance: ${balanceLamports / LAMPORTS_PER_SOL} SOL`);
  if (balanceLamports === 0) {
    console.warn("⚠ Wallet has 0 SOL — simulateTransaction will fail with AccountNotFound (a fresh wallet has no on-chain account at all). Fund the wallet with at least a small amount before running this.\n");
  }

  const curveInfo = await withRetry(() => connection.getAccountInfo(deriveBondingCurve(mint)));
  let instructions;
  let venue: "pumpfun" | "pumpswap";

  if (curveInfo) {
    const curve = decodeStruct<{
      creator: string;
      quote_mint: string;
      complete: boolean;
      virtual_quote_reserves: bigint;
      virtual_token_reserves: bigint;
    }>(curveInfo.data.subarray(ANCHOR_ACCOUNT_DISCRIMINATOR_LEN), BondingCurveAccountSchema);

    if (!curve.complete) {
      venue = "pumpfun";
      console.log("Venue: pump.fun bonding curve (not yet migrated)");
      if (curve.quote_mint !== NATIVE_SOL_SENTINEL) {
        console.error(`✗ This mint's bonding curve is quoted in ${curve.quote_mint}, not native SOL — this bot's live executor doesn't support that yet.`);
        process.exit(1);
      }
      const reserves = { sol: BigInt(curve.virtual_quote_reserves), token: BigInt(curve.virtual_token_reserves) };
      const solLamports = BigInt(Math.round(solAmount * LAMPORTS_PER_SOL));
      const expectedTokensOut = constantProductSwapOut(reserves.sol, reserves.token, solLamports, config.paperFeeBps);
      const amountTokens = (expectedTokensOut * BigInt(10000 - config.live.slippageBps)) / 10000n;
      console.log(`Current reserves: ${Number(reserves.sol) / LAMPORTS_PER_SOL} SOL / ${reserves.token} raw tokens`);
      console.log(`Expected tokens out (pre-slippage estimate): ${expectedTokensOut}`);
      console.log(`Requesting exactly: ${amountTokens} tokens, max cost ${solAmount} SOL\n`);

      const tokenProgram = await resolveTokenProgram(connection, mint);
      console.log(`Resolved token program: ${tokenProgram.toBase58()}\n`);

      instructions = [
        createAtaIdempotentIx(payer.publicKey, mint, tokenProgram, payer.publicKey),
        await buildPumpFunBuyIx({ user: payer.publicKey, mint, creator: new PublicKey(curve.creator), tokenProgram, amountTokens, maxSolCostLamports: solLamports }),
      ];
    } else {
      venue = "pumpswap";
    }
  } else {
    venue = "pumpswap";
  }

  if (venue === "pumpswap") {
    console.log("Venue: PumpSwap (migrated pool)");
    const poolAddress = await findPumpSwapPoolForMint(connection, mint.toBase58());
    if (!poolAddress) {
      console.error("✗ No bonding curve AND no PumpSwap pool found for this mint — is it a real, currently-tradable pump.fun mint?");
      process.exit(1);
    }
    console.log(`Found pool: ${poolAddress}`);

    const ammSdk = new OnlinePumpAmmSdk(connection);
    const state = await ammSdk.swapSolanaState(new PublicKey(poolAddress), payer.publicKey);
    const solIsBase = pumpSwapSolIsBase(state);
    console.log(`Orientation: SOL is ${solIsBase ? "base" : "quote"} (base=${state.pool.baseMint.toBase58()}, quote=${state.pool.quoteMint.toBase58()})`);
    if (solIsBase) {
      console.error("✗ This pool has SOL as base_mint (inverted orientation) — this bot's live executor doesn't support that yet.");
      process.exit(1);
    }

    const reserves = { sol: state.poolQuoteAmount.toString(), token: state.poolBaseAmount.toString() };
    const solLamports = BigInt(Math.round(solAmount * LAMPORTS_PER_SOL));
    const expectedTokensOut = constantProductSwapOut(BigInt(reserves.sol) + BigInt(state.pool.virtualQuoteReserves.toString()), BigInt(reserves.token), solLamports, config.paperFeeBps);
    const amountTokens = (expectedTokensOut * BigInt(10000 - config.live.slippageBps)) / 10000n;
    console.log(`Current reserves: ${Number(reserves.sol) / LAMPORTS_PER_SOL} SOL / ${reserves.token} raw tokens`);
    console.log(`Expected tokens out (pre-slippage estimate): ${expectedTokensOut}`);
    console.log(`Requesting exactly: ${amountTokens} tokens, max cost ${solAmount} SOL\n`);

    instructions = await buildPumpSwapAcquireTokenIx(state, amountTokens, solLamports);
  }

  if (!instructions) {
    console.error("✗ Could not build instructions");
    process.exit(1);
  }

  const allIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: config.live.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.live.computeUnitPriceMicroLamports }),
    ...instructions,
  ];

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: allIxs }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);

  console.log("--- Running simulateTransaction (no funds spent, nothing broadcast) ---\n");
  const sim = await connection.simulateTransaction(tx, { commitment: "confirmed", replaceRecentBlockhash: true });

  if (sim.value.err) {
    console.error("✗ SIMULATION FAILED:", JSON.stringify(sim.value.err));
    console.error("\nProgram logs:");
    (sim.value.logs || []).forEach((l) => console.error("  " + l));
    process.exit(1);
  }

  console.log(`✓ SIMULATION SUCCEEDED — compute units consumed: ${sim.value.unitsConsumed}`);
  console.log("\nProgram logs:");
  (sim.value.logs || []).forEach((l) => console.log("  " + l));
  console.log("\nThis instruction set is ready for a real live submission (same code path LiveExecutor uses).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
