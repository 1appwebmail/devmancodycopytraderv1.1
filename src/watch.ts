import { assertRunnable, config } from "./config.js";
import { App } from "./app.js";

assertRunnable();

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
  console.log(
    `[${evt.venue}] ${evt.direction.toUpperCase()} ${evt.mint.slice(0, 8)}… by ${evt.trader.slice(0, 8)}… ` +
      `${evt.solAmount.toFixed(4)} SOL — ${evt.signature.slice(0, 12)}…`,
  );
});

app.on("create", (evt) => {
  console.log(`[create] ${evt.symbol} "${evt.name}" mint=${evt.mint.slice(0, 8)}… creator=${evt.creator.slice(0, 8)}…`);
});

app.on("migration", (evt) => {
  console.log(`[migrate] ${evt.mint.slice(0, 8)}… bonding curve completed → PumpSwap`);
});

app.on("buy", (position) => {
  console.log(`[paper] opened position ${position.id.slice(0, 8)} — ${position.mint.slice(0, 8)}… @ ${position.entryPrice}`);
});

app.on("sell", (position, entry, reason) => {
  console.log(`[paper] ${reason} on ${position.mint.slice(0, 8)}… — ${entry.solAmount.toFixed(4)} SOL, balance=${app.executor.getState().balanceSol.toFixed(4)} SOL`);
});

console.log(`Watching ${config.targetWallets.length} wallet(s), mode=${config.mode}, starting balance=${config.startingPaperBalanceSol} SOL`);
app.start();
