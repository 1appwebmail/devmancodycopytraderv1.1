// One-off connectivity smoke test: subscribes broadly to the Pump program
// (not a specific wallet) via PublicNode's free Yellowstone gRPC endpoint to
// prove the connect -> subscribe -> decode pipeline works, then exits.
import { startGrpcSource } from "./grpcSource.js";
import { decodeTransaction } from "./decodeTransaction.js";
import { PUMP_PROGRAM_ID } from "../constants.js";

let count = 0;
const TIMEOUT_MS = 15_000;

startGrpcSource({
  name: "publicnode",
  endpoint: "https://solana-yellowstone-grpc.publicnode.com:443",
  targetWallets: [PUMP_PROGRAM_ID],
  onTransaction: (info, slot) => {
    const decoded = decodeTransaction(info, slot);
    for (const t of decoded.trades) {
      count++;
      console.log(`#${count} [${t.venue}] ${t.direction} ${t.mint.slice(0, 8)}… ${t.solAmount.toFixed(4)} SOL`);
    }
  },
  onStatus: (source, status, detail) => console.log(`[${source}] ${status}${detail ? " — " + detail : ""}`),
});

setTimeout(() => {
  console.log(`\nDone. Decoded ${count} trade event(s) in ${TIMEOUT_MS / 1000}s.`);
  process.exit(count > 0 ? 0 : 1);
}, TIMEOUT_MS);
