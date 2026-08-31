import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID } from "../constants.js";

// Only the PDAs still needed outside of instruction construction remain here — actual
// buy/sell instruction construction (and all the PDAs that go with it) is delegated to the
// official @pump-fun/pump-sdk and @pump-fun/pump-swap-sdk packages, see src/live/instructions.ts.
// deriveGlobal/deriveGlobalConfig are kept for src/live/globalAccounts.ts, a standalone
// verification script (npm run live:verify-fee-recipients) — not part of the live trading path.

const PUMP_PROGRAM = new PublicKey(PUMP_PROGRAM_ID);
const PUMP_AMM_PROGRAM = new PublicKey(PUMP_AMM_PROGRAM_ID);

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

export function deriveGlobal(): PublicKey {
  return pda([Buffer.from("global")], PUMP_PROGRAM);
}

export function deriveBondingCurve(mint: PublicKey): PublicKey {
  return pda([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM);
}

export function deriveGlobalConfig(): PublicKey {
  return pda([Buffer.from("global_config")], PUMP_AMM_PROGRAM);
}

// allowOwnerOffCurve=true throughout — every "owner" this project derives an ATA for (bonding
// curve, fee recipients, etc.) is itself a PDA, never a valid ed25519 point on the curve.
export function deriveAta(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
}
