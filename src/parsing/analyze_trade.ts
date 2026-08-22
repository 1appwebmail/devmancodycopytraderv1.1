import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { PUMP_AMM_PROGRAM_ID, LAMPORTS_PER_SOL } from "../constants.js";
import { decodePumpAmmEvent } from "./decode.js";
import { PoolRegistry } from "../pools/registry.js";
import { getPumpswapReserves } from "../pricing/liveReserves.js";
import { priceSolPerToken, marketCapSol } from "../pricing.js";

const SIG = process.argv[2] ?? "25GhwAicuEt6RvmSqxS7XwhbW24NeDNBYYKSwukQrriVNrkaE7VtFyzghJsgfWhBF3fAB3KsZxmNJvhbkyRxnCCC";

async function main() {
  const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
  const tx = await connection.getTransaction(SIG, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx?.meta) throw new Error("tx not found");
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });

  for (const inner of tx.meta.innerInstructions ?? []) {
    for (const ix of inner.instructions as any[]) {
      const pid = keys.get(ix.programIdIndex)?.toBase58();
      if (pid !== PUMP_AMM_PROGRAM_ID) continue;
      const data = Buffer.from(bs58.decode(ix.data));
      const evt = decodePumpAmmEvent(data);
      if (!evt || evt.name !== "BuyEvent") continue;
      const d = evt.data as any;

      const preReserves = { sol: BigInt(d.pool_quote_token_reserves), token: BigInt(d.pool_base_token_reserves) };
      const preMarginalPrice = priceSolPerToken(preReserves.sol, preReserves.token);

      const avgTradePrice = Number(d.quote_amount_in) / Number(d.base_amount_out);

      // Reconstruct implied post-trade reserves from the trade's own deltas
      const impliedPostSol = preReserves.sol + BigInt(d.quote_amount_in_with_lp_fee);
      const impliedPostToken = preReserves.token - BigInt(d.base_amount_out);
      const impliedPostMarginalPrice = priceSolPerToken(impliedPostSol, impliedPostToken);

      console.log("=== event data ===");
      console.log("pool:", d.pool);
      console.log("quote_amount_in (target spent):", Number(d.quote_amount_in) / LAMPORTS_PER_SOL, "SOL");
      console.log("base_amount_out (target received):", d.base_amount_out.toString());
      console.log();
      console.log("=== PRE-trade reserves (what the event field actually reports) ===");
      console.log("marginal price at pre-trade reserves:", preMarginalPrice.toExponential(6), "lamports/rawtoken");
      console.log();
      console.log("target's own avg execution price:", avgTradePrice.toExponential(6), "lamports/rawtoken");
      console.log("ratio avg/pre-marginal:", (avgTradePrice / preMarginalPrice).toFixed(4), "(should be >1 for a buy, and this IS the old buggy assumption's basis)");
      console.log();
      console.log("=== implied POST-trade reserves (pre + this trade's own delta) ===");
      console.log("marginal price at implied post-trade reserves:", impliedPostMarginalPrice.toExponential(6));
      console.log("ratio post-marginal/avg:", (impliedPostMarginalPrice / avgTradePrice).toFixed(4), "(should be >1 for a buy)");
      console.log();

      // Now fetch the pool's ACTUAL live reserves (what our bot fetches for its own fill)
      const registry = new PoolRegistry(connection);
      const liveReserves = await getPumpswapReserves(connection, d.pool, registry);
      if (liveReserves) {
        const livePrice = priceSolPerToken(liveReserves.sol, liveReserves.token);
        console.log("=== LIVE current pool reserves (fetched now, what the bot would use today) ===");
        console.log("current marginal price:", livePrice.toExponential(6));
        console.log("current price vs target avg price ratio:", (livePrice / avgTradePrice).toFixed(4));
        console.log("(note: this may differ from the moment-of-copy price since more trades have happened since)");
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
