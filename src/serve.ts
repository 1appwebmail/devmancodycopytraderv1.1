import { assertRunnable, config } from "./config.js";
import { App } from "./app.js";
import { startApiServer } from "./api/server.js";

assertRunnable();

// Defense in depth: a single unexpected error anywhere in an async fire-and-forget path
// (RPC hiccup, malformed event, etc.) should never take the whole bot down and silently stop
// trading/monitoring. Every call site is expected to handle its own errors already, but this is
// the last line of defense in case one doesn't.
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION (bot is still running):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION (bot is still running):", err);
});

const app = new App();

app.on("status", (source, status, detail) => {
  console.log(`[${source}] ${status}${detail ? ` — ${detail}` : ""}`);
});
app.on("trade", (evt) => {
  console.log(`[${evt.venue}] ${evt.direction.toUpperCase()} ${evt.mint.slice(0, 8)}… ${evt.solAmount.toFixed(4)} SOL`);
});
app.on("buy", (position) => {
  console.log(`[paper] opened ${position.id.slice(0, 8)} — ${position.mint.slice(0, 8)}… @ ${position.entryPrice}`);
});
app.on("sell", (position, entry, reason) => {
  console.log(`[paper] ${reason} on ${position.mint.slice(0, 8)}… — ${entry.solAmount.toFixed(4)} SOL, balance=${app.executor.getState().balanceSol.toFixed(4)} SOL`);
});

console.log(`Starting: ${config.targetWallets.length} wallet(s), mode=${config.mode}, starting balance=${config.startingPaperBalanceSol} SOL`);
app.start();
startApiServer(app);
