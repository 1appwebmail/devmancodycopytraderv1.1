import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function optionalNumberOrNull(name: string): number | null {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

export interface LadderTier {
  pct: number; // profit % from entry that triggers this tier
  fraction: number; // fraction (0-1) of the ORIGINAL position size to sell at this tier
}

/** Parses "50:25,100:25,200:25" into tiers sorted ascending by pct — sell 25% of the original
 *  position at +50%, another 25% at +100%, another 25% at +200%, leaving the remainder to ride
 *  on the existing trailing-stop/stop-loss/time-limit rules. Empty/unset disables laddering
 *  entirely (falls back to the single-shot TAKE_PROFIT_PCT exit, unchanged from before). */
function parseLadderTiers(raw: string): LadderTier[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const [pctStr, fractionPctStr] = pair.split(":").map((s) => s.trim());
      const pct = Number(pctStr);
      const fraction = Number(fractionPctStr) / 100;
      if (Number.isNaN(pct) || Number.isNaN(fraction) || fraction <= 0) {
        throw new Error(`Invalid LADDER_TP tier "${pair}" — expected "pct:fractionPct", e.g. "50:25"`);
      }
      return { pct, fraction };
    })
    .sort((a, b) => a.pct - b.pct);
}

export const config = {
  grpc: {
    publicnode: {
      endpoint: optional("PUBLICNODE_GRPC_ENDPOINT", "https://solana-yellowstone-grpc.publicnode.com:443"),
      token: process.env.PUBLICNODE_GRPC_TOKEN || undefined,
    },
    helius: {
      endpoint: process.env.HELIUS_GRPC_ENDPOINT || undefined,
      token: process.env.HELIUS_API_KEY || undefined,
    },
  },
  rpcHttpUrl: optional("RPC_HTTP_URL", "https://api.mainnet-beta.solana.com"),
  targetWallets: optional("TARGET_WALLETS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  mode: (optional("MODE", "paper") as "paper" | "live"),
  startingPaperBalanceSol: Number(optional("STARTING_PAPER_BALANCE_SOL", "10")),
  paperFeeBps: Number(optional("PAPER_FEE_BPS", "100")), // flat approximate fee (1%); see pricing.ts
  positionSizeSol: Number(optional("POSITION_SIZE_SOL", "0.5")),
  maxConcurrentPositions: Number(optional("MAX_CONCURRENT_POSITIONS", "5")),
  stopLossPct: Number(optional("STOP_LOSS_PCT", "25")),
  takeProfitPct: Number(optional("TAKE_PROFIT_PCT", "100")),
  trailingStopPct: Number(optional("TRAILING_STOP_PCT", "15")),
  ladderTiers: parseLadderTiers(optional("LADDER_TP", "")),
  maxHoldSeconds: Number(optional("MAX_HOLD_SECONDS", "0")), // 0 = disabled
  positionPollIntervalMs: Number(optional("POSITION_POLL_INTERVAL_MS", "5000")),
  copySell: optional("COPY_SELL", "true") === "true",
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    // Comma-separated for multiple recipients (each must have already messaged the bot at least
    // once — Telegram bots can't DM someone who hasn't started a conversation with them).
    chatIds: optional("TELEGRAM_CHAT_ID", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
  apiPort: Number(optional("API_PORT", "4000")),
  botName: optional("BOT_NAME", "Devmancody-CopytraderBot"),
  // Startup defaults for the live-editable entry filters (src/settings.ts). Leave blank/unset
  // for "no limit" — the UI's Save Filters button can still change these at any time; this just
  // means a restart no longer resets them back to unlimited.
  filterDefaults: {
    minMcapUsd: optionalNumberOrNull("MIN_MCAP_USD"),
    maxMcapUsd: optionalNumberOrNull("MAX_MCAP_USD"),
    minAgeSeconds: optionalNumberOrNull("MIN_AGE_SECONDS"),
    maxAgeSeconds: optionalNumberOrNull("MAX_AGE_SECONDS"),
    // Filters out tiny "chart support" buys (e.g. 0.001 SOL) that aren't a real signal, and
    // optionally caps how large a target buy you're willing to follow.
    minTargetBuySol: optionalNumberOrNull("MIN_TARGET_BUY_SOL"),
    maxTargetBuySol: optionalNumberOrNull("MAX_TARGET_BUY_SOL"),
  },
};

export function assertRunnable() {
  if (config.targetWallets.length === 0) {
    throw new Error("TARGET_WALLETS is empty — set at least one wallet address to copy in .env");
  }
  if (!config.grpc.helius.endpoint && !config.grpc.publicnode.endpoint) {
    throw new Error("No gRPC endpoint configured (need PUBLICNODE_GRPC_ENDPOINT and/or HELIUS_GRPC_ENDPOINT)");
  }
  if (config.mode !== "paper" && config.mode !== "live") {
    throw new Error(`MODE must be "paper" or "live", got "${config.mode}"`);
  }
  if (config.mode === "live") {
    // There is no live executor yet (see App) — fail loudly at startup rather than silently run
    // paper logic while the UI/logs claim to be live, or crash confusingly deeper in the stack.
    throw new Error(
      "MODE=live is not implemented yet — live execution (real swap building, signing, submission) hasn't been built. Set MODE=paper.",
    );
  }
}
