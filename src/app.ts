import { Connection } from "@solana/web3.js";
import { EventEmitter } from "node:events";
import { config } from "./config.js";
import { Ingestion } from "./ingestion/index.js";
import { evaluateTrade, type StrategyState, type TradeContext } from "./strategy.js";
import { PaperExecutor, type Reserves } from "./executor/paper.js";
import { PositionMonitor } from "./positionManager.js";
import { getPumpswapReserves, getReservesForPosition } from "./pricing/liveReserves.js";
import { MintInfoCache } from "./pricing/mintInfo.js";
import { TokenAgeCache } from "./pricing/tokenAge.js";
import { TokenMetadataCache } from "./pricing/tokenMetadata.js";
import { startSolUsdPoller, getSolUsdPrice } from "./pricing/solUsd.js";
import { marketCapSol } from "./pricing.js";
import { LAMPORTS_PER_SOL } from "./constants.js";
import { appendTradeLog } from "./reporting/tradeLog.js";
import { sendTelegramMessage } from "./reporting/telegram.js";
import { buildCopyBuyNotification, buildCopySellNotification, buildAutonomousExitNotification } from "./reporting/notifications.js";
import { getSettings, isFilteringByMcap, isFilteringByAge } from "./settings.js";
import { loadState, persistState } from "./reporting/statePersistence.js";
import type { TradeEvent, CreateEvent, MigrationEvent, Position, TradeLogEntry } from "./types.js";

export class App extends EventEmitter {
  readonly connection: Connection;
  readonly ingestion: Ingestion;
  readonly executor: PaperExecutor;
  readonly positionMonitor: PositionMonitor;
  readonly mintInfo: MintInfoCache;
  readonly tokenAge: TokenAgeCache;
  readonly tokenMetadata: TokenMetadataCache;
  // Closes the multi-target-wallet duplicate-buy race — see handleTargetTrade.
  private readonly pendingBuyMints = new Set<string>();

  constructor() {
    super();
    this.connection = new Connection(config.rpcHttpUrl, "confirmed");
    this.ingestion = new Ingestion(this.connection);
    const restored = loadState();
    this.executor = new PaperExecutor(config.startingPaperBalanceSol, restored ?? undefined);
    if (restored) {
      console.log(`Restored ${config.mode} state: balance=${restored.balanceSol.toFixed(4)} SOL, ${restored.positions.filter((p) => p.status === "open").length} open position(s)`);
    }
    this.positionMonitor = new PositionMonitor(this.connection, this.executor, this.ingestion.getPoolRegistry());
    this.mintInfo = new MintInfoCache(this.connection);
    this.tokenAge = new TokenAgeCache(this.connection);
    this.tokenMetadata = new TokenMetadataCache(this.connection);

    this.ingestion.on("status", (source, status, detail) => this.emit("status", source, status, detail));
    this.ingestion.on("trade", (evt) => void this.handleTargetTrade(evt));
    this.ingestion.on("create", (evt) => {
      // Pre-warm: avoids an RPC round trip on the first copy trade for this mint.
      this.mintInfo.set(evt.mint, evt.totalSupplyRaw);
      this.tokenAge.set(evt.mint, evt.timestamp);
      this.tokenMetadata.set(evt.mint, evt.symbol);
      this.emit("create", evt);
    });
    this.ingestion.on("migration", (evt) => this.emit("migration", evt));

    this.positionMonitor.on("exit", (position, entry, reason) => this.handleExit(position, entry, reason));
    this.positionMonitor.on("priceUpdate", (update) => this.emit("priceUpdate", update));
  }

  start() {
    this.ingestion.start();
    this.positionMonitor.start();
    startSolUsdPoller();
  }

  /** Manually close a position at the current market price (frontend "Close" button). */
  async closePosition(positionId: string): Promise<TradeLogEntry | null> {
    const position = this.executor.getState().positions.find((p) => p.id === positionId && p.status === "open");
    if (!position) return null;

    const reserves = await getReservesForPosition(this.connection, position, this.ingestion.getPoolRegistry());
    if (!reserves) return null;

    const entry = this.executor.sell(position.id, reserves, "manual", 1);
    if (entry) await this.handleExit(position, entry, "manual");
    return entry;
  }

  /** Toggles the "hold" flag from the UI — voids every automatic exit (TP/SL/trailing/ladder/time-limit/copy-sell) for this position. */
  setPositionHold(positionId: string, held: boolean): Position | null {
    const position = this.executor.getState().positions.find((p) => p.id === positionId && p.status === "open");
    if (!position) return null;
    position.held = held;
    persistState(this.executor.getState());
    this.emit("buy", position); // re-broadcast — the UI upserts positions by id
    return position;
  }

  private async handleTargetTrade(event: TradeEvent) {
    this.emit("trade", event);

    // Closes the multi-wallet race: handleTargetTrade isn't awaited by its caller, so if two
    // target wallets buy the same mint within milliseconds of each other, both calls can read
    // "no open position yet" before either buy has actually landed, and both would copy it. This
    // lock is set synchronously — before any `await` — so the second event bails out immediately
    // instead of racing the first through the (much slower) filter/reserve-lookup/execute path.
    if (event.direction === "buy") {
      if (this.pendingBuyMints.has(event.mint)) return;
      const alreadyOpen = this.executor.getState().positions.some((p) => p.mint === event.mint && p.status === "open");
      if (alreadyOpen) return;
      this.pendingBuyMints.add(event.mint);
      try {
        await this.handleBuyCandidate(event);
      } finally {
        this.pendingBuyMints.delete(event.mint);
      }
    } else {
      await this.handleSellCandidate(event);
    }
  }

  private async handleBuyCandidate(event: TradeEvent) {
    const state: StrategyState = { openPositions: this.executor.getState().positions };
    const settings = getSettings();
    const context = await this.resolveTradeContext(event, settings);
    const decision = evaluateTrade(event, state, context, settings);
    if (!decision) {
      if (isFilteringByMcap() || isFilteringByAge()) {
        console.log(
          `[filter] skipped ${event.mint.slice(0, 8)}… buy (${event.solAmount.toFixed(4)} SOL from ${event.trader.slice(0, 8)}…): ` +
            `mcapUsd=${context.mcapUsd ?? "unresolved"} ageSeconds=${context.ageSeconds ?? "unresolved"} ` +
            `bounds={minMcapUsd=${settings.minMcapUsd},maxMcapUsd=${settings.maxMcapUsd},minAgeSeconds=${settings.minAgeSeconds},maxAgeSeconds=${settings.maxAgeSeconds}}`,
        );
      }
      return;
    }
    if (decision.kind !== "buy") return; // shouldn't happen — evaluateTrade(buy event) only ever returns a buy Decision or null

    const reserves = await this.resolveFillReserves(event);
    if (!reserves) return; // couldn't get accurate pricing (e.g. pool RPC lookup failed) — skip rather than fill at a wrong price

    const position = this.executor.buy(decision.mint, decision.venue, decision.solAmount, reserves, decision.pool);
    if (position) {
      position.targetWallet = event.trader;
      this.emit("buy", position);
      console.log(`🟢 BUY ${decision.mint.slice(0, 8)}… — ${decision.solAmount} SOL (copying ${event.trader.slice(0, 8)}…)`);
      persistState(this.executor.getState());
      const trade = this.executor.getState().trades.at(-1);
      if (trade) {
        void appendTradeLog(trade);
        void this.enrichAndLogCopy(trade, event);
      }
      void this.resolvePositionMcap(position);
    }
  }

  private async handleSellCandidate(event: TradeEvent) {
    const state: StrategyState = { openPositions: this.executor.getState().positions };
    const decision = evaluateTrade(event, state, { mcapUsd: null, ageSeconds: null }, getSettings());
    if (!decision || decision.kind !== "sell") return;

    const heldPosition = state.openPositions.find((p) => p.id === decision.positionId);
    if (heldPosition?.held) {
      console.log(`[hold] skipped copy_sell on ${heldPosition.mint.slice(0, 8)}… — position is held, following the target's sell would defeat the point of holding`);
      return;
    }

    const reserves = await this.resolveFillReserves(event);
    if (!reserves) return;

    const entry = this.executor.sell(decision.positionId, reserves, "copy_sell", 1);
    if (entry) {
      void this.enrichAndLogCopy(entry, event);
      void this.handleExit(
        this.executor.getState().positions.find((p) => p.id === decision.positionId)!,
        entry,
        "copy_sell",
      );
    }
  }

  /**
   * Reserves to price our copy fill against. Pump.fun's TradeEvent reports the bonding curve's
   * POST-trade reserves (verified against live chain data — see src/parsing/verify_reserves_order.ts),
   * so we can use the event's embedded values directly with no extra RPC call. PumpSwap's
   * BuyEvent/SellEvent, on the other hand, report PRE-trade reserves (verified — see
   * verify_reserves_order_amm.ts): using them directly would price our fill as if we traded
   * BEFORE the target's own price impact, understating what we'd actually pay. So for PumpSwap
   * we fetch the pool's live reserves instead, which costs one RPC round trip per copy trade.
   */
  private async resolveFillReserves(event: TradeEvent): Promise<Reserves | null> {
    if (event.venue === "pumpfun") {
      return { sol: event.postSolReserves, token: event.postTokenReserves };
    }
    if (!event.pool) return null;
    return getPumpswapReserves(this.connection, event.pool, this.ingestion.getPoolRegistry());
  }

  /**
   * Resolves mcap/age for the entry filters, but only does the RPC work when a filter is
   * actually configured and only for buys (sells aren't filtered). Both lookups are cached
   * per-mint after the first hit, so this only adds latency on a mint we've never seen before.
   */
  private async resolveTradeContext(event: TradeEvent, settings: ReturnType<typeof getSettings>): Promise<TradeContext> {
    if (event.direction !== "buy") return { mcapUsd: null, ageSeconds: null };

    const needMcap = isFilteringByMcap();
    const needAge = isFilteringByAge();
    if (!needMcap && !needAge) return { mcapUsd: null, ageSeconds: null };

    const [totalSupplyRaw, createdAt] = await Promise.all([
      needMcap ? this.mintInfo.resolveTotalSupply(event.mint) : Promise.resolve(null),
      needAge ? this.tokenAge.resolveCreatedAt(event.mint) : Promise.resolve(null),
    ]);

    const solUsd = needMcap ? getSolUsdPrice() : null;
    const mcapUsd =
      needMcap && totalSupplyRaw !== null && solUsd !== null
        ? marketCapSol(event.solAmount / event.tokenAmount, totalSupplyRaw) * solUsd
        : null;
    // TokenAgeCache can underestimate a very high-volume mint's true age (it only looks at the
    // most recent 1000 signatures — see TokenAgeCache) but should never make it look NEWER than
    // this specific event. A negative result means the estimate is unreliable for this mint;
    // treat it as unresolved rather than pass a nonsensical age into the filter.
    const rawAgeSeconds = needAge && createdAt !== null ? event.timestamp - createdAt : null;
    const ageSeconds = rawAgeSeconds !== null && rawAgeSeconds >= 0 ? rawAgeSeconds : null;

    return { mcapUsd, ageSeconds };
  }

  /**
   * Resolves each side's fully-diluted mcap (target's average fill price vs. ours) and emits a
   * paired "copy" log entry. Runs after the trade already executed and after it's already been
   * appended to the trade log — the mint total-supply lookup can be a cache miss on a brand-new
   * mint, and we never want that to delay the actual copy trade or double-write the log.
   */
  private async enrichAndLogCopy(entry: TradeLogEntry, targetEvent: TradeEvent) {
    const totalSupplyRaw = await this.mintInfo.resolveTotalSupply(entry.mint);
    const solUsd = getSolUsdPrice();
    void this.resolveAndBroadcastSymbol(entry.mint);

    let targetMcapSol: number | null = null;
    let botMcapSol: number | null = null;
    if (totalSupplyRaw !== null) {
      const targetSolPerRawToken = targetEvent.solAmount / targetEvent.tokenAmount;
      targetMcapSol = marketCapSol(targetSolPerRawToken, totalSupplyRaw);
      const botSolPerRawToken = entry.price / LAMPORTS_PER_SOL; // entry.price is lamports/raw-token
      botMcapSol = marketCapSol(botSolPerRawToken, totalSupplyRaw);
      entry.mcapSol = botMcapSol; // in-memory only, reflected in /api/state; the log line was already written
      entry.mcapUsd = solUsd !== null ? botMcapSol * solUsd : null;
    }

    this.emit("copy", {
      timestamp: entry.timestamp,
      mint: entry.mint,
      venue: entry.venue,
      direction: entry.direction,
      targetWallet: targetEvent.trader,
      targetSolAmount: targetEvent.solAmount,
      targetMcapSol,
      targetMcapUsd: targetMcapSol !== null && solUsd !== null ? targetMcapSol * solUsd : null,
      botSolAmount: entry.solAmount,
      botMcapSol,
      botMcapUsd: botMcapSol !== null && solUsd !== null ? botMcapSol * solUsd : null,
      targetSignature: targetEvent.signature,
    });

    if (entry.direction === "buy") {
      void this.notify(buildCopyBuyNotification({ targetEvent, entry, totalSupplyRaw, solUsdPrice: solUsd }));
    } else {
      const position = this.executor.getState().positions.find((p) => p.id === entry.positionId);
      if (position) {
        void this.notify(buildCopySellNotification({ targetEvent, entry, position, totalSupplyRaw, solUsdPrice: solUsd }));
      }
    }
  }

  /** Best-effort ticker resolution for the UI, fired off in the background — never blocks a trade. */
  private async resolveAndBroadcastSymbol(mint: string) {
    if (this.tokenMetadata.getCached(mint)) return; // already known, nothing to broadcast
    const symbol = await this.tokenMetadata.resolveSymbol(mint);
    if (symbol) this.emit("symbol", { mint, symbol });
  }

  /**
   * Resolves the mint's total supply once (cached forever after) and stamps the position with
   * `totalSupplyRaw` + `entryMcapUsd` so the UI can show a readable "$18.3K" style mcap instead of
   * a near-unreadable raw per-token price like 2.270e-7 SOL. `totalSupplyRaw` also lets
   * positionManager compute the position's live mcap on every price tick with no further RPC
   * calls. Runs in the background after the buy already executed — never delays a trade.
   */
  private async resolvePositionMcap(position: Position) {
    const totalSupplyRaw = await this.mintInfo.resolveTotalSupply(position.mint);
    if (totalSupplyRaw === null) return;
    position.totalSupplyRaw = totalSupplyRaw.toString();
    const solUsd = getSolUsdPrice();
    const entryMcapSol = marketCapSol(position.entryPrice / LAMPORTS_PER_SOL, totalSupplyRaw);
    position.entryMcapSol = entryMcapSol;
    position.entryMcapUsd = solUsd !== null ? entryMcapSol * solUsd : null;
    this.emit("buy", position); // re-broadcast — the UI upserts positions by id, so this just fills in the mcap fields
  }

  private async handleExit(position: Position, entry: TradeLogEntry, reason: string) {
    this.emit("sell", position, entry, reason);
    persistState(this.executor.getState());
    await appendTradeLog(entry);
    console.log(`🔴 SELL ${position.mint.slice(0, 8)}… (${reason})${position.status === "closed" ? ` — realized PnL ${position.realizedPnlSol.toFixed(4)} SOL` : ""}`);
    // copy_sell already gets its own rich notification from enrichAndLogCopy (it has the target's
    // side of the trade, which this generic exit path doesn't) — sending another here would double up.
    if (reason !== "copy_sell") {
      void this.notify(buildAutonomousExitNotification(position, entry, reason));
    }
  }

  private async notify(text: string) {
    console.log(text);
    await sendTelegramMessage(`<b>${config.botName}</b>\n${text}`);
  }
}
