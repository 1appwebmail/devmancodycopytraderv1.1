import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID } from "../constants.js";
import { decodePumpEvent, decodePumpAmmEvent } from "./decode.js";

const RPC = process.env.RPC_HTTP_URL ?? "https://api.mainnet-beta.solana.com";

async function checkProgram(connection: Connection, programId: string, decode: (b: Buffer) => ReturnType<typeof decodePumpEvent>) {
  const pk = new PublicKey(programId);
  const sigs = await connection.getSignaturesForAddress(pk, { limit: 20 });
  console.log(`\n=== ${programId} — ${sigs.length} recent signatures ===`);
  let decoded = 0;
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await connection.getTransaction(s.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx?.meta?.innerInstructions) continue;
    for (const inner of tx.meta.innerInstructions) {
      for (const ix of inner.instructions) {
        const programIdIndex = (ix as any).programIdIndex;
        const accountKeys = tx.transaction.message.getAccountKeys({
          accountKeysFromLookups: tx.meta.loadedAddresses,
        });
        const ixProgramId = accountKeys.get(programIdIndex)?.toBase58();
        if (ixProgramId !== programId) continue;
        const data = bs58.decode((ix as any).data);
        const evt = decode(Buffer.from(data));
        if (evt) {
          decoded++;
          console.log(`[${s.signature.slice(0, 12)}...] ${evt.name}:`, summarize(evt.data));
        }
      }
    }
  }
  console.log(`decoded ${decoded} event(s) for ${programId}`);
  return decoded;
}

function summarize(data: Record<string, unknown>) {
  const keys = ["mint", "user", "is_buy", "sol_amount", "token_amount", "quote_amount_in", "quote_amount_out", "base_amount_in", "base_amount_out", "pool", "name", "symbol"];
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in data) out[k] = data[k];
  return out;
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const a = await checkProgram(connection, PUMP_PROGRAM_ID, decodePumpEvent);
  const b = await checkProgram(connection, PUMP_AMM_PROGRAM_ID, decodePumpAmmEvent);
  if (a === 0 && b === 0) {
    console.error("\nFAILED: decoded zero events from live transactions — schema/discriminator mismatch.");
    process.exit(1);
  }
  console.log("\nOK: decoder validated against live mainnet transactions.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
