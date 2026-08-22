const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_PRICE_URL = `https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`;
const POLL_INTERVAL_MS = 60_000;

let cachedPrice: number | null = null;
let started = false;

async function refresh() {
  try {
    const res = await fetch(JUPITER_PRICE_URL);
    if (!res.ok) return;
    const data = (await res.json()) as Record<string, { usdPrice?: number }>;
    const price = data[SOL_MINT]?.usdPrice;
    if (typeof price === "number" && price > 0) cachedPrice = price;
  } catch (err) {
    console.error("solUsd: failed to refresh SOL/USD price:", err);
    // keep the last known value — never let a flaky price feed disrupt trading
  }
}

/** Starts a background poller for the SOL/USD price. Safe to call multiple times. */
export function startSolUsdPoller() {
  if (started) return;
  started = true;
  void refresh();
  setInterval(() => void refresh(), POLL_INTERVAL_MS);
}

export function getSolUsdPrice(): number | null {
  return cachedPrice;
}
