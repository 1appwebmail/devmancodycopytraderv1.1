// Same invariant check as verify_reserves_order.ts, but for PumpSwap's BuyEvent:
// on a constant-product curve, avg execution price must sit strictly between the pre-trade
// and post-trade marginal price. For a buy, marginal price rises, so:
//   marginalPrice(reserves) > avgTradePrice  =>  reserves are POST-trade
//   marginalPrice(reserves) < avgTradePrice  =>  reserves are PRE-trade
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { PUMP_AMM_PROGRAM_ID } from "../constants.js";
import { decodePumpAmmEvent } from "./decode.js";

async function main() {
  const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
  const pk = new PublicKey(PUMP_AMM_PROGRAM_ID);
  const sigs = await connection.getSignaturesForAddress(pk, { limit: 30 });
  console.log(`fetched ${sigs.length} signatures`);

  let checked = 0;
  for (const s of sigs) {
    if (s.err) continue;
    let tx;
    try {
      tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    } catch {
      continue;
    }
    if (!tx?.meta?.innerInstructions) continue;
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
    for (const inner of tx.meta.innerInstructions) {
      for (const ix of inner.instructions) {
        const programIdIndex = (ix as any).programIdIndex;
        const ixProgramId = keys.get(programIdIndex)?.toBase58();
        if (ixProgramId !== PUMP_AMM_PROGRAM_ID) continue;
        const data = Buffer.from(bs58.decode((ix as any).data));
        const evt = decodePumpAmmEvent(data);
        if (!evt || evt.name !== "BuyEvent") continue;
        const d = evt.data as any;
        checked++;

        const avgTradePrice = Number(d.quote_amount_in) / Number(d.base_amount_out);
        const marginalPriceAtEventReserves = Number(d.pool_quote_token_reserves) / Number(d.pool_base_token_reserves);

        console.log(`sig=${s.signature.slice(0, 12)}... pool=${d.pool.slice(0, 8)}...`);
        console.log(`  avgTradePrice=${avgTradePrice.toExponential(6)}`);
        console.log(`  marginalPriceAtEventReserves=${marginalPriceAtEventReserves.toExponential(6)}`);
        console.log(`  ratio (marginal/avg) = ${(marginalPriceAtEventReserves / avgTradePrice).toFixed(4)}`);
        console.log(`  => reserves are ${marginalPriceAtEventReserves > avgTradePrice ? "POST-trade (marginal > avg, as expected for a buy)" : "PRE-trade (marginal < avg — reserves are BEFORE this trade)"}`);
        console.log();
      }
    }
  }
  console.log(`checked ${checked} BuyEvent(s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
