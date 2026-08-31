import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "../constants.js";
import { deriveAta } from "./pda.js";
import { withRetry } from "../pricing/withRetry.js";

/** Same detection approach as pricing/tokenMetadata.ts — checks the mint account's owner program
 *  rather than assuming classic SPL Token, since some pump.fun/PumpSwap mints use Token-2022. */
export async function resolveTokenProgram(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await withRetry(() => connection.getAccountInfo(mint));
  if (!info) throw new Error(`Mint account not found: ${mint.toBase58()}`);
  return info.owner.toBase58() === TOKEN_2022_PROGRAM_ID ? new PublicKey(TOKEN_2022_PROGRAM_ID) : new PublicKey(TOKEN_PROGRAM_ID);
}

/** Idempotent create — safe to include unconditionally even if the ATA already exists (a plain
 *  create would fail on a second buy of the same mint). Costs a tiny bit of rent the first time
 *  only; the instruction is a no-op if the account is already there. */
export function createAtaIdempotentIx(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey, payer: PublicKey): TransactionInstruction {
  const ata = deriveAta(owner, mint, tokenProgram);
  return createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, mint, tokenProgram);
}
