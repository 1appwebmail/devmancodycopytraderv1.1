import { Connection } from "@solana/web3.js";
import { TokenMetadataCache } from "./tokenMetadata.js";

const mints = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["8ZkUY4EM1nhWf2hihmWiPKaRy3gqxdoMD5LMQsPMpump", "FBbDVF7Ksv7VjvPW2KgyudNJThwHoCEqnMvJsLrJpump"];

async function main() {
  const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
  const cache = new TokenMetadataCache(connection);
  for (const mint of mints) {
    const symbol = await cache.resolveSymbol(mint);
    console.log(`${mint} -> ${symbol === null ? "FAILED TO RESOLVE" : `"${symbol}"`}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
