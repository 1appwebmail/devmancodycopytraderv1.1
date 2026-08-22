// One-off verification: for a real buy TradeEvent, is (virtual_sol_reserves, virtual_token_reserves)
// the PRE-trade or POST-trade reserve state? Mathematical invariant: on a constant-product curve,
// price rises monotonically during a buy, so avg execution price (sol_amount/token_amount) must sit
// strictly between the pre-trade marginal price and the post-trade marginal price. So:
//   marginalPrice(reserves) > avgTradePrice  =>  reserves are POST-trade
//   marginalPrice(reserves) < avgTradePrice  =>  reserves are PRE-trade
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { PUMP_PROGRAM_ID } from "../constants.js";
import { decodePumpEvent } from "./decode.js";

async function main() {
  const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
  const pk = new PublicKey(PUMP_PROGRAM_ID);
  const sigs = await connection.getSignaturesForAddress(pk, { limit: 50 });
  console.log(`fetched ${sigs.length} signatures`);

  let nonErrCount = 0;
  for (const s of sigs) {
    if (s.err) continue;
    nonErrCount++;
    let tx;
    try {
      tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    } catch (e) {
      console.log(`getTransaction failed for ${s.signature.slice(0, 12)}: ${e}`);
      continue;
    }
    if (!tx) {
      console.log(`null tx for ${s.signature.slice(0, 12)}`);
      continue;
    }
    if (!tx.meta?.innerInstructions) {
      console.log(`no innerInstructions for ${s.signature.slice(0, 12)}, innerInstructionsNone-ish`);
      continue;
    }
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
    for (const inner of tx.meta.innerInstructions) {
      for (const ix of inner.instructions) {
        const programIdIndex = (ix as any).programIdIndex;
        const ixProgramId = keys.get(programIdIndex)?.toBase58();
        if (ixProgramId !== PUMP_PROGRAM_ID) continue;
        const data = Buffer.from(bs58.decode((ix as any).data));
        const evt = decodePumpEvent(data);
        if (!evt || evt.name !== "TradeEvent") continue;
        const d = evt.data as any;
        console.log(`found TradeEvent is_buy=${d.is_buy} mint=${d.mint.slice(0, 8)}...`);
        if (!d.is_buy) continue; // only checking buys for this invariant

        const avgTradePrice = Number(d.sol_amount) / Number(d.token_amount);
        const marginalPriceAtEventReserves = Number(d.virtual_sol_reserves) / Number(d.virtual_token_reserves);

        console.log(`sig=${s.signature.slice(0, 12)}... mint=${d.mint.slice(0, 8)}...`);
        console.log(`  avgTradePrice=${avgTradePrice.toExponential(6)}`);
        console.log(`  marginalPriceAtEventReserves=${marginalPriceAtEventReserves.toExponential(6)}`);
        console.log(`  ratio (marginal/avg) = ${(marginalPriceAtEventReserves / avgTradePrice).toFixed(4)}`);
        console.log(`  => reserves are ${marginalPriceAtEventReserves > avgTradePrice ? "POST-trade (marginal > avg, as expected for a buy)" : "PRE-trade (marginal < avg — reserves are BEFORE this trade)"}`);
        console.log();
      }
    }
  }
  console.log(`processed ${nonErrCount} non-err signatures`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
