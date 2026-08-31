import { Connection } from "@solana/web3.js";
import bs58 from "bs58";
import { PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID } from "../constants.js";
import { decodePumpEvent, decodePumpAmmEvent } from "../parsing/decode.js";
import { withRetry } from "../pricing/withRetry.js";

export interface ParsedFill {
  solLamports: bigint;
  tokenAmount: bigint;
}

/**
 * Reads back the ACTUAL amounts filled by our own just-confirmed transaction, by decoding the
 * same TradeEvent/BuyEvent/SellEvent self-CPI events the ingestion pipeline already knows how to
 * parse (see src/parsing/decode.ts) — rather than trusting the pre-trade estimate we submitted.
 * On-chain execution can fill at a slightly different price than estimated (the whole reason for
 * slippage tolerance), so this is what Position/TradeLogEntry should actually be built from.
 */
export async function parseOwnFill(
  connection: Connection,
  signature: string,
  venue: "pumpfun" | "pumpswap",
  direction: "buy" | "sell",
  // Only meaningful for venue="pumpswap": whether the pool's SOL leg is base_mint rather than
  // quote_mint (see instructions.ts's solIsBase) — needed to map base/quote amounts back to
  // sol/token correctly regardless of which side SOL sits on.
  solIsBase = false,
): Promise<ParsedFill | null> {
  const tx = await withRetry(() => connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }));
  if (!tx?.meta?.innerInstructions) return null;

  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
  const programId = venue === "pumpfun" ? PUMP_PROGRAM_ID : PUMP_AMM_PROGRAM_ID;

  for (const inner of tx.meta.innerInstructions) {
    for (const ix of inner.instructions as { programIdIndex: number; data: string }[]) {
      if (keys.get(ix.programIdIndex)?.toBase58() !== programId) continue;
      const raw = Buffer.from(bs58.decode(ix.data));

      if (venue === "pumpfun") {
        const evt = decodePumpEvent(raw);
        if (evt?.name !== "TradeEvent") continue;
        const d = evt.data as { sol_amount: bigint; token_amount: bigint };
        return { solLamports: BigInt(d.sol_amount), tokenAmount: BigInt(d.token_amount) };
      } else {
        // Which raw AMM instruction ("buy" vs "sell") we called depends on solIsBase (see
        // instructions.ts's buildPumpSwapAcquireTokenIx/DisposeTokenIx) — not directly on our
        // `direction` — so figure out which event to look for the same way those builders picked
        // the instruction.
        const calledBuyIx = solIsBase ? direction === "sell" : direction === "buy";
        const wantName = calledBuyIx ? "BuyEvent" : "SellEvent";
        const evt = decodePumpAmmEvent(raw);
        if (evt?.name !== wantName) continue;
        if (evt.name === "BuyEvent") {
          const d = evt.data as { quote_amount_in: bigint; base_amount_out: bigint };
          return solIsBase
            ? { solLamports: BigInt(d.base_amount_out), tokenAmount: BigInt(d.quote_amount_in) }
            : { solLamports: BigInt(d.quote_amount_in), tokenAmount: BigInt(d.base_amount_out) };
        } else {
          const d = evt.data as { quote_amount_out: bigint; base_amount_in: bigint };
          return solIsBase
            ? { solLamports: BigInt(d.base_amount_in), tokenAmount: BigInt(d.quote_amount_out) }
            : { solLamports: BigInt(d.quote_amount_out), tokenAmount: BigInt(d.base_amount_in) };
        }
      }
    }
  }
  return null;
}
