import { Connection } from "@solana/web3.js";
import { EventEmitter } from "node:events";
import { config } from "./config.js";
import { Ingestion } from "./ingestion/index.js";
import { evaluateTrade, explainBuySkip, type StrategyState, type TradeContext } from "./strategy.js";
import { PaperExecutor, type Reserves } from "./executor/paper.js";
import { LiveExecutor } from "./executor/live.js";
import { loadLiveKeypair } from "./live/keys.js";
import type { Executor } from "./executor/types.js";
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
import { getSettings, getEffectiveSettings, isFilteringByMcap, isFilteringByAge } from "./settings.js";
import { loadState, persistState } from "./reporting/statePersistence.js";
import { TargetHoldingsTracker } from "./pricing/targetHoldings.js";
import type { TradeEvent, CreateEvent, MigrationEvent, Position, TradeLogEntry } from "./types.js";

// Human-readable text for every reason explainBuySkip can return — keeps the [skip] log line
// meaningful instead of always dumping mcap/age context that isn't necessarily the real reason
// (e.g. a target's small top-up buy skipped by MIN_TARGET_BUY_SOL, not mcap/age at all).
const BUY_SKIP_MESSAGES: Record<string, string> = {
  already_open: "already holding a position in this mint",
  max_concurrent_positions: "at MAX_CONCURRENT_POSITIONS limit",
  target_buy_too_small: "target's buy was below MIN_TARGET_BUY_SOL",
  target_buy_too_large: "target's buy was above MAX_TARGET_BUY_SOL",
  mcap_unresolved: "mcap filter active but mcap couldn't be resolved",
  mcap_too_low: "mcap below MIN_MCAP_USD",
  mcap_too_high: "mcap above MAX_MCAP_USD",
  age_unresolved: "age filter active but age couldn't be resolved",
  age_too_young: "token younger than MIN_AGE_SECONDS",
  age_too_old: "token older than MAX_AGE_SECONDS",
  unknown: "passed all checks — this shouldn't happen, evaluateTrade and explainBuySkip may have drifted out of sync",
};

export class App extends EventEmitter {
  readonly connection: Connection;
  readonly ingestion: Ingestion;
  readonly executor: Executor;
  readonly positionMonitor: PositionMonitor;
  readonly mintInfo: MintInfoCache;
  readonly tokenAge: TokenAgeCache;
  readonly tokenMetadata: TokenMetadataCache;
  // Closes the multi-target-wallet duplicate-buy race — see handleTargetTrade.
  private readonly pendingBuyMints = new Set<string>();
  // Tracks each target wallet's observed holdings per mint, purely from trade events this bot has
  // seen — lets a copy-sell mirror the fraction the target actually sold instead of always fully
  // exiting the position regardless of how much of their own position they sold. See
  // pricing/targetHoldings.ts.
  private readonly targetHoldings = new TargetHoldingsTracker();

  constructor() {
    super();
    this.connection = new Connection(config.rpcHttpUrl, "confirmed");
    this.ingestion = new Ingestion(this.connection);
    const restored = loadState();
    if (config.mode === "live") {
      const keypair = loadLiveKeypair();
      console.log(`[live] trading wallet: ${keypair.publicKey.toBase58()}`);
      this.executor = new LiveExecutor(this.connection, keypair, restored ?? undefined);
    } else {
      this.executor = new PaperExecutor(config.startingPaperBalanceSol, restored ?? undefined);
    }
    if (restored) {
      console.log(`Restored ${config.mode} state: balance=${restored.balanceSol.toFixed(4)} SOL, ${restored.positions.filter((p) => p.status === "open").length} open position(s)`);
    }
    this.positionMonitor = new PositionMonitor(this.connection, this.executor, this.ingestion.getPoolRegistry());
    this.mintInfo = new MintInfoCache(this.connection);
    this.tokenAge = new TokenAgeCache(this.connection);
    this.tokenMetadata = new TokenMetadataCache(this.connection);

    this.ingestion.on("status", (source, status, detail) => this.emit("status", source, status, detail));
    this.ingestion.on("trade", (evt) => void this.handleTargetTrade(evt));
    // Pre-warms mcap/age/symbol caches for EVERY mint this process observes being created,
    // regardless of who created it — see Ingestion's ENABLE_CREATE_PREWARM subscription. Avoids an
    // RPC round trip on a target wallet's first copy trade for a mint someone else launched, which
    // was otherwise the dominant cost in a live copy-trade decision (verified via [timing] logs).
    this.ingestion.on("mintSeen", (evt) => {
      this.mintInfo.set(evt.mint, evt.totalSupplyRaw);
      this.tokenAge.set(evt.mint, evt.timestamp);
      this.tokenMetadata.set(evt.mint, evt.symbol);
    });
    // UI/business-logic signal — scoped to target-wallet-caused launches only (unlike mintSeen
    // above), so the UI's create feed doesn't flood with every pump.fun token platform-wide.
    this.ingestion.on("create", (evt) => this.emit("create", evt));
    this.ingestion.on("migration", (evt) => this.emit("migration", evt));

    this.positionMonitor.on("exit", (position, entry, reason) => this.handleExit(position, entry, reason));
    this.positionMonitor.on("priceUpdate", (update) => this.emit("priceUpdate", update));
  }

  start() {
    this.ingestion.start();
    this.positionMonitor.start();
    startSolUsdPoller();
    void this.executor.refreshBalance();
  }

  /** Manually close a position at the current market price (frontend "Close" button). */
  async closePosition(positionId: string): Promise<TradeLogEntry | null> {
    const position = this.executor.getState().positions.find((p) => p.id === positionId && p.status === "open");
    if (!position) return null;

    const reserves = await getReservesForPosition(this.connection, position, this.ingestion.getPoolRegistry());
    if (!reserves) return null;

    const entry = await this.executor.sell(position.id, reserves, "manual", 1);
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

    // Update the target's tracked holdings for EVERY trade we see, regardless of whether our own
    // filters end up copying it — this models the target's REAL holdings, not just the subset of
    // their trades we acted on, so a later partial sell computes an accurate fraction. Must happen
    // before the sellFraction computation in handleSellCandidate uses it.
    if (event.direction === "buy") {
      this.targetHoldings.recordBuy(event.trader, event.mint, event.tokenAmount);
    }

    // Closes the multi-wallet race: handleTargetTrade isn't awaited by its caller, so if two
    // target wallets buy the same mint within milliseconds of each other, both calls can read
    // "no open position yet" before either buy has actually landed, and both would copy it. This
    // lock is set synchronously — before any `await` — so the second event bails out immediately
    // instead of racing the first through the (much slower) filter/reserve-lookup/execute path.
    const receivedAt = Date.now();
    if (event.direction === "buy") {
      if (this.pendingBuyMints.has(event.mint)) return;
      const alreadyOpen = this.executor.getState().positions.some((p) => p.mint === event.mint && p.status === "open");
      if (alreadyOpen) return;
      this.pendingBuyMints.add(event.mint);
      try {
        await this.handleBuyCandidate(event, receivedAt);
      } finally {
        this.pendingBuyMints.delete(event.mint);
      }
    } else {
      await this.handleSellCandidate(event);
    }
  }

  private async handleBuyCandidate(event: TradeEvent, receivedAt: number) {
    const state: StrategyState = { openPositions: this.executor.getState().positions };
    // Each target wallet's OWN filter overrides if they have one (see settings.ts) — different
    // wallets genuinely trade at different mcap/age ranges, so a single global filter tuned for
    // one wallet silently drops another's legitimate signals entirely.
    const settings = getEffectiveSettings(event.trader);
    const context = await this.resolveTradeContext(event, settings);
    const decision = evaluateTrade(event, state, context, settings);
    if (!decision) {
      const reason = explainBuySkip(event, state, context, settings);
      console.log(
        `[skip] ${event.mint.slice(0, 8)}… buy (${event.solAmount.toFixed(4)} SOL from ${event.trader.slice(0, 8)}…): ${BUY_SKIP_MESSAGES[reason ?? "unknown"] ?? reason} ` +
          `[mcapUsd=${context.mcapUsd?.toFixed(0) ?? "unresolved"} ageSeconds=${context.ageSeconds ?? "unresolved"} ` +
          `minTargetBuySol=${settings.minTargetBuySol} maxTargetBuySol=${settings.maxTargetBuySol} ` +
          `minMcapUsd=${settings.minMcapUsd} maxMcapUsd=${settings.maxMcapUsd} minAgeSeconds=${settings.minAgeSeconds} maxAgeSeconds=${settings.maxAgeSeconds}]`,
      );
      return;
    }
    if (decision.kind !== "buy") return; // shouldn't happen — evaluateTrade(buy event) only ever returns a buy Decision or null

    const filtersResolvedAt = Date.now();
    const reserves = await this.resolveFillReserves(event);
    if (!reserves) return; // couldn't get accurate pricing (e.g. pool RPC lookup failed) — skip rather than fill at a wrong price
    const reservesResolvedAt = Date.now();

    const position = await this.executor.buy(decision.mint, decision.venue, decision.solAmount, reserves, decision.pool);
    const buyDoneAt = Date.now();

    // Breaks down where the total target-trade-to-our-fill latency actually goes, so a bad fill
    // price can be diagnosed as "our own pipeline was slow" (detection/filters/reserves — Beam
    // tips/providers can't fix this) vs. "submission/confirmation was slow" (Beam/priority-fee
    // territory) instead of guessing. eventAtMs is the target's own on-chain blockTime — detectionMs
    // includes gRPC delivery lag, which can itself be a meaningful chunk of the total.
    const eventAtMs = event.timestamp * 1000;
    console.log(
      `[timing] ${event.mint.slice(0, 8)}… buy: detection=${receivedAt - eventAtMs}ms filters=${filtersResolvedAt - receivedAt}ms reserves=${reservesResolvedAt - filtersResolvedAt}ms submit+confirm=${buyDoneAt - reservesResolvedAt}ms total=${buyDoneAt - eventAtMs}ms`,
    );

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
    // Fraction of the target's OWN tracked holdings this sell represents — computed once here
    // (recordSell also mutates their tracked balance down, so it must only be called once per
    // sell event) and threaded through evaluateTrade so a partial sell copies proportionally
    // instead of always fully exiting our position. See pricing/targetHoldings.ts.
    const sellFraction = this.targetHoldings.recordSell(event.trader, event.mint, event.tokenAmount);
    const decision = evaluateTrade(event, state, { mcapUsd: null, ageSeconds: null, sellFraction }, getSettings());
    if (!decision || decision.kind !== "sell") return;

    const heldPosition = state.openPositions.find((p) => p.id === decision.positionId);
    if (heldPosition?.held) {
      console.log(`[hold] skipped copy_sell on ${heldPosition.mint.slice(0, 8)}… — position is held, following the target's sell would defeat the point of holding`);
      return;
    }

    const reserves = await this.resolveFillReserves(event);
    if (!reserves) return;

    console.log(`[copy_sell] ${event.mint.slice(0, 8)}… selling ${(decision.fraction * 100).toFixed(1)}% of position (target sold ${(sellFraction * 100).toFixed(1)}% of their tracked holdings)`);
    const entry = await this.executor.sell(decision.positionId, reserves, "copy_sell", decision.fraction);
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
    if (event.direction !== "buy") return { mcapUsd: null, ageSeconds: null, sellFraction: null };

    // Checked against THIS event's effective (possibly per-wallet) settings, not the global
    // default — a wallet-specific override that adds an mcap/age bound the global doesn't have
    // (or vice versa) must still correctly trigger/skip the RPC lookup below.
    const needMcap = isFilteringByMcap(settings);
    const needAge = isFilteringByAge(settings);
    if (!needMcap && !needAge) return { mcapUsd: null, ageSeconds: null, sellFraction: null };

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

    return { mcapUsd, ageSeconds, sellFraction: null };
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
