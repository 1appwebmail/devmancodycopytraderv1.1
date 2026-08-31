// Verifies getPumpFunFeeRecipient/getPumpSwapProtocolFeeRecipient two ways: (1) against the
// live Global/GlobalConfig account state, (2) cross-checked against the `fee_recipient`/
// `protocol_fee_recipient` field embedded directly in a real recent TradeEvent/BuyEvent — an
// independent confirmation that doesn't depend on my own PDA derivation being right.
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config.js";
import { PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID } from "../constants.js";
import { decodePumpEvent, decodePumpAmmEvent } from "../parsing/decode.js";
import { getPumpFunFeeRecipient, getPumpSwapProtocolFeeRecipient } from "./globalAccounts.js";
import { deriveGlobal, deriveGlobalConfig } from "./pda.js";

async function main() {
  const connection = new Connection(config.rpcHttpUrl, "confirmed");

  console.log("Global PDA:", deriveGlobal().toBase58());
  console.log("GlobalConfig PDA:", deriveGlobalConfig().toBase58());
  console.log();

  const derivedPumpFunFee = await getPumpFunFeeRecipient(connection);
  const derivedPumpSwapFee = await getPumpSwapProtocolFeeRecipient(connection);
  console.log("Derived pump.fun fee_recipient (fee_recipients[0]):", derivedPumpFunFee);
  console.log("Derived PumpSwap protocol_fee_recipient[0]:", derivedPumpSwapFee);
  console.log();

  // Cross-check against real recent TradeEvents' own fee_recipient field — tally frequency
  // across a larger sample rather than trust one data point, since pump.fun's Global also has a
  // `fee_recipients[7]` backup array and may rotate like PumpSwap does.
  const pumpSigs = await connection.getSignaturesForAddress(new PublicKey(PUMP_PROGRAM_ID), { limit: 100 });
  const seen: Record<string, number> = {};
  for (const s of pumpSigs) {
    if (s.err) continue;
    const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx?.meta?.innerInstructions) continue;
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
    for (const inner of tx.meta.innerInstructions) {
      for (const ix of inner.instructions as any[]) {
        if (keys.get(ix.programIdIndex)?.toBase58() !== PUMP_PROGRAM_ID) continue;
        const evt = decodePumpEvent(Buffer.from(bs58.decode(ix.data)));
        if (evt?.name !== "TradeEvent") continue;
        const r = (evt.data as any).fee_recipient as string;
        seen[r] = (seen[r] ?? 0) + 1;
      }
    }
  }
  console.log("fee_recipient frequency across", Object.values(seen).reduce((a, b) => a + b, 0), "real TradeEvents:");
  for (const [addr, count] of Object.entries(seen).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count.toString().padStart(3)}x  ${addr}${addr === derivedPumpFunFee ? "  <-- matches our derived fee_recipients[0]" : ""}`);
  }
  console.log(seen[derivedPumpFunFee] ? "Our derived value IS among the real rotating recipients ✓" : "Our derived value did NOT appear in this sample ✗");
  console.log();

  const ammSigs = await connection.getSignaturesForAddress(new PublicKey(PUMP_AMM_PROGRAM_ID), { limit: 30 });
  for (const s of ammSigs) {
    if (s.err) continue;
    const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx?.meta?.innerInstructions) continue;
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
    for (const inner of tx.meta.innerInstructions) {
      for (const ix of inner.instructions as any[]) {
        if (keys.get(ix.programIdIndex)?.toBase58() !== PUMP_AMM_PROGRAM_ID) continue;
        const evt = decodePumpAmmEvent(Buffer.from(bs58.decode(ix.data)));
        if (evt?.name !== "BuyEvent" && evt?.name !== "SellEvent") continue;
        const eventFeeRecipient = (evt.data as any).protocol_fee_recipient;
        console.log(`Real ${evt.name} (${s.signature.slice(0, 10)}...) protocol_fee_recipient:`, eventFeeRecipient);
        console.log(eventFeeRecipient === derivedPumpSwapFee ? "MATCH ✓" : "MISMATCH (may just be a different valid recipient in the pool of 8 — not necessarily wrong)");
        console.log();
        break;
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
