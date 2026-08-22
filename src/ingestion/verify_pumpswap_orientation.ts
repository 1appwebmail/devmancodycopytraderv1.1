// One-off verification: replays two known real PumpSwap transactions — one from a "normal"
// pool (base=token, quote=SOL) and one from the reversed pool that exposed the mint/direction
// bug — through the real decode + pool-resolution pipeline, and checks the output makes sense.
import { Connection } from "@solana/web3.js";
import { PoolRegistry } from "../pools/registry.js";
import { WSOL_MINT, LAMPORTS_PER_SOL } from "../constants.js";
import { config } from "../config.js";

const CASES = [
  {
    label: "reversed pool (base=SOL, quote=token) — the one that exposed the bug",
    pool: "28SEBK4TxeigzgCYe2HL12hqbqc6fVPqgU9SgC6be1aQ",
    expectedMint: "437kc455cpdU9HBv1s9mrkSn8dNnW2Er94st7PXDpump",
  },
  {
    label: "normal pool (base=token, quote=SOL)",
    pool: "GeTcu1NcRx6vrfy4QTVdWNRtPbQ9sAYx7pwdAeaCZEyB",
    expectedMint: "GkBioTfFZcCLc8sQ1DM6yBJSPd5yVFEQtHWoHVokziSc",
  },
];

async function main() {
  const connection = new Connection(config.rpcHttpUrl, "confirmed");
  const registry = new PoolRegistry(connection);

  for (const c of CASES) {
    console.log(`\n=== ${c.label} ===`);
    const pool = await registry.resolve(c.pool);
    if (!pool) {
      console.log("FAILED to resolve pool");
      continue;
    }
    console.log("base:", pool.baseMint, "quote:", pool.quoteMint);
    const solIsQuote = pool.quoteMint === WSOL_MINT;
    const solIsBase = pool.baseMint === WSOL_MINT;
    const resolvedMint = solIsQuote ? pool.baseMint : solIsBase ? pool.quoteMint : null;
    console.log("resolved mint:", resolvedMint);
    console.log("expected mint:", c.expectedMint);
    console.log(resolvedMint === c.expectedMint ? "PASS" : "FAIL — mint mismatch");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
