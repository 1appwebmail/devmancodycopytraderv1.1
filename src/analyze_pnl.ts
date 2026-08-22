import { Connection } from "@solana/web3.js";
import { readFile } from "node:fs/promises";
import { config } from "./config.js";
import { getPumpfunReserves, getPumpswapReserves } from "./pricing/liveReserves.js";
import { PoolRegistry } from "./pools/registry.js";
import { priceSolPerToken } from "./pricing.js";
import { computeUnrealizedPnl } from "./positionManager.js";
import { getSolUsdPrice, startSolUsdPoller } from "./pricing/solUsd.js";
import type { Position, TradeLogEntry } from "./types.js";

async function main() {
  const res = await fetch("http://localhost:4000/api/state");
  const state = (await res.json()) as {
    balanceSol: number;
    startingBalanceSol: number;
    positions: Position[];
    trades: TradeLogEntry[];
    solUsdPrice: number | null;
  };

  startSolUsdPoller();
  await new Promise((r) => setTimeout(r, 800)); // let the SOL/USD poller resolve
  const solUsd = getSolUsdPrice() ?? state.solUsdPrice;

  const connection = new Connection(config.rpcHttpUrl, "confirmed");
  const poolRegistry = new PoolRegistry(connection);

  const openPositions = state.positions.filter((p) => p.status === "open");
  const closedPositions = state.positions.filter((p) => p.status === "closed");

  console.log("=".repeat(70));
  console.log("ACCOUNT SUMMARY");
  console.log("=".repeat(70));
  const capitalLockedInOpenPositions = openPositions.reduce((sum, p) => sum + p.entrySolAmount, 0);
  console.log(`Starting balance:        ${state.startingBalanceSol.toFixed(4)} SOL`);
  console.log(`Cash balance now:        ${state.balanceSol.toFixed(4)} SOL`);
  console.log(`Capital locked in ${openPositions.length} open positions: ${capitalLockedInOpenPositions.toFixed(4)} SOL (cost basis, not loss — cash+this ≠ PnL by itself)`);
  console.log();

  console.log("=".repeat(70));
  console.log(`CLOSED POSITIONS (${closedPositions.length})`);
  console.log("=".repeat(70));
  const closedByReason: Record<string, { count: number; pnl: number }> = {};
  const byWallet: Record<string, { count: number; realizedPnl: number; unrealizedPnl: number; wins: number }> = {};
  let totalClosedPnl = 0;
  for (const p of closedPositions) {
    const reason = p.exitReason ?? "unknown";
    closedByReason[reason] ??= { count: 0, pnl: 0 };
    closedByReason[reason].count++;
    closedByReason[reason].pnl += p.realizedPnlSol;
    totalClosedPnl += p.realizedPnlSol;

    const wallet = p.targetWallet ?? "unknown (pre-tracking trade)";
    byWallet[wallet] ??= { count: 0, realizedPnl: 0, unrealizedPnl: 0, wins: 0 };
    byWallet[wallet].count++;
    byWallet[wallet].realizedPnl += p.realizedPnlSol;
    if (p.realizedPnlSol > 0) byWallet[wallet].wins++;
  }
  const wins = closedPositions.filter((p) => p.realizedPnlSol > 0).length;
  const losses = closedPositions.filter((p) => p.realizedPnlSol <= 0).length;
  console.log(`Win rate: ${wins}/${closedPositions.length} (${closedPositions.length ? ((wins / closedPositions.length) * 100).toFixed(1) : "0"}%)`);
  console.log(`Total realized PnL from closed positions: ${totalClosedPnl >= 0 ? "+" : ""}${totalClosedPnl.toFixed(4)} SOL`);
  console.log();
  console.log("By exit reason:");
  for (const [reason, { count, pnl }] of Object.entries(closedByReason).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${reason.padEnd(15)} count=${count.toString().padEnd(4)} pnl=${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL`);
  }
  console.log();

  console.log("=".repeat(70));
  console.log(`OPEN POSITIONS (${openPositions.length}) — fetching live prices...`);
  console.log("=".repeat(70));
  let totalUnrealized = 0;
  let totalRealizedOnOpenPartials = 0;
  const rows: { mint: string; unrealizedPnl: number; unrealizedPct: number; ageMin: number }[] = [];
  for (const p of openPositions) {
    totalRealizedOnOpenPartials += p.realizedPnlSol;
    const reserves =
      p.venue === "pumpfun" ? await getPumpfunReserves(connection, p.mint) : p.pool ? await getPumpswapReserves(connection, p.pool, poolRegistry) : null;
    if (!reserves || reserves.token === 0n) {
      console.log(`  ${p.mint.slice(0, 10)}… — couldn't fetch live price, skipping`);
      continue;
    }
    const currentPrice = priceSolPerToken(reserves.sol, reserves.token);
    const pnl = computeUnrealizedPnl(p, currentPrice, solUsd);
    totalUnrealized += pnl.unrealizedPnlSol;

    const wallet = p.targetWallet ?? "unknown (pre-tracking trade)";
    byWallet[wallet] ??= { count: 0, realizedPnl: 0, unrealizedPnl: 0, wins: 0 };
    byWallet[wallet].count++;
    byWallet[wallet].unrealizedPnl += pnl.unrealizedPnlSol;

    rows.push({
      mint: p.mint,
      unrealizedPnl: pnl.unrealizedPnlSol,
      unrealizedPct: pnl.unrealizedPnlPct,
      ageMin: (Date.now() / 1000 - p.openedAt) / 60,
    });
  }
  rows.sort((a, b) => b.unrealizedPnl - a.unrealizedPnl);
  for (const r of rows) {
    console.log(
      `  ${r.mint.slice(0, 10)}… ${r.unrealizedPnl >= 0 ? "+" : ""}${r.unrealizedPnl.toFixed(4)} SOL (${r.unrealizedPct >= 0 ? "+" : ""}${r.unrealizedPct.toFixed(1)}%) — ${r.ageMin.toFixed(0)}m old`,
    );
  }
  console.log();
  console.log(`Total unrealized PnL on open positions: ${totalUnrealized >= 0 ? "+" : ""}${totalUnrealized.toFixed(4)} SOL`);
  console.log();

  console.log("=".repeat(70));
  console.log("BY TARGET WALLET");
  console.log("=".repeat(70));
  const walletEntries = Object.entries(byWallet)
    .map(([wallet, w]) => ({ wallet, ...w, total: w.realizedPnl + w.unrealizedPnl }))
    .sort((a, b) => b.total - a.total);
  for (const w of walletEntries) {
    const closedCount = w.count - (openPositions.filter((p) => (p.targetWallet ?? "unknown (pre-tracking trade)") === w.wallet).length);
    const winRate = closedCount > 0 ? `${((w.wins / closedCount) * 100).toFixed(0)}%` : "n/a";
    const label = w.wallet.startsWith("unknown") ? w.wallet : `${w.wallet.slice(0, 6)}…${w.wallet.slice(-4)}`;
    console.log(
      `  ${label.padEnd(28)} trades=${w.count.toString().padEnd(4)} winRate=${winRate.padEnd(6)} realized=${w.realizedPnl >= 0 ? "+" : ""}${w.realizedPnl.toFixed(4)} SOL  unrealized=${w.unrealizedPnl >= 0 ? "+" : ""}${w.unrealizedPnl.toFixed(4)} SOL  total=${w.total >= 0 ? "+" : ""}${w.total.toFixed(4)} SOL`,
    );
  }
  if (walletEntries.length === 1 && walletEntries[0].wallet.startsWith("unknown")) {
    console.log();
    console.log("  (No per-wallet data yet — this tracking was just added. It'll populate as new copy trades come in.)");
  }
  console.log();

  console.log("=".repeat(70));
  console.log("GRAND TOTAL");
  console.log("=".repeat(70));
  // True realized PnL = every position's own realizedPnlSol (fully-closed positions, plus any
  // partial sells still sitting on an open position) — NOT balance-minus-starting, which also
  // conflates capital currently locked up in open positions with actual gains/losses.
  const totalRealizedPnl = totalClosedPnl + totalRealizedOnOpenPartials;
  const grandTotalPnl = totalRealizedPnl + totalUnrealized;
  console.log(`Realized PnL (banked):      ${totalRealizedPnl >= 0 ? "+" : ""}${totalRealizedPnl.toFixed(4)} SOL`);
  console.log(`Unrealized PnL (open):      ${totalUnrealized >= 0 ? "+" : ""}${totalUnrealized.toFixed(4)} SOL`);
  console.log(`Combined PnL:               ${grandTotalPnl >= 0 ? "+" : ""}${grandTotalPnl.toFixed(4)} SOL${solUsd ? ` ($${(grandTotalPnl * solUsd).toFixed(2)})` : ""}`);
  console.log(`Return on starting balance: ${((grandTotalPnl / state.startingBalanceSol) * 100).toFixed(2)}%`);
  console.log();
  console.log(`Sanity check — cash + locked capital + unrealized should equal starting + combined PnL:`);
  const reconstructed = state.balanceSol + capitalLockedInOpenPositions + totalUnrealized;
  console.log(`  ${reconstructed.toFixed(4)} SOL vs expected ${(state.startingBalanceSol + grandTotalPnl).toFixed(4)} SOL`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
