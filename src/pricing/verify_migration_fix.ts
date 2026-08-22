import { Connection } from "@solana/web3.js";
import { config } from "../config.js";
import { PoolRegistry } from "../pools/registry.js";
import { getReservesForPosition } from "./liveReserves.js";
import { priceSolPerToken } from "../pricing.js";
import type { Position } from "../types.js";

async function main() {
  const connection = new Connection(config.rpcHttpUrl, "confirmed");
  const registry = new PoolRegistry(connection);

  // Shaped like a real position that bought on pump.fun before this mint migrated to PumpSwap —
  // exactly the scenario from the bug report.
  const position: Position = {
    id: "test-pos",
    mint: "FWV3Y2nFo6GZUiYSfQX1JYmDkoLnPbv3AjoTWJVTpump",
    venue: "pumpfun",
    openedAt: Date.now() / 1000,
    entrySolAmount: 1,
    entryTokenAmount: 1,
    entryPrice: 1,
    remainingTokenAmount: 1,
    realizedPnlSol: 0,
    status: "open",
    highWaterPrice: 1,
    ladderTiersHit: [],
  };

  console.log("Before:", { venue: position.venue, pool: position.pool });
  const reserves = await getReservesForPosition(connection, position, registry);
  console.log("After: ", { venue: position.venue, pool: position.pool });
  console.log("reserves:", reserves);

  if (!reserves) {
    console.log("\nFAILED: still got null reserves");
    process.exit(1);
  }
  if (reserves.sol === 0n || reserves.token === 0n) {
    console.log("\nFAILED: reserves are zero — the bug is still present");
    process.exit(1);
  }
  const price = priceSolPerToken(reserves.sol, reserves.token);
  console.log(`\nOK: got real non-zero reserves, implied price ${price.toExponential(4)} lamports/raw-token`);
  console.log(`Position auto-migrated: venue=${position.venue}, pool=${position.pool}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
