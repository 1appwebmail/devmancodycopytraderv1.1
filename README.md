# Devmancody CopyTrader

[![CI](https://github.com/1appwebmail/devmancodycopytraderv1.1/actions/workflows/ci.yml/badge.svg)](https://github.com/1appwebmail/devmancodycopytraderv1.1/actions/workflows/ci.yml)

A free, self-hosted Solana copy-trading bot for pump.fun and PumpSwap. Point it at the wallets you want to follow, tune how it filters and exits, and run it — no subscription, no per-trade fee, no middleman holding your keys.

This exists because most copy-trading bots charge a cut of every trade (or a flat monthly fee) to do something you can run yourself for the cost of a cheap VPS. This is that: the same core idea, open, self-hosted, and free.

> **You are responsible for your own funds.** This project executes real on-chain transactions with a private key you provide. Read the [Safety notes](#safety-notes) section before ever setting `MODE=live`. The maintainer is not responsible for losses.

## Features

- **Copy-trades pump.fun and PumpSwap** (migrated pump.fun pools) — detects a target wallet's buy/sell in real time over Yellowstone gRPC and mirrors it
- **Paper and live modes** — simulate with a virtual balance first, flip to real trading only when you're ready
- **Per-wallet entry filters** — market cap, token age, and target buy-size bounds, overridable per target wallet (live-editable, no restart needed)
- **Take-profit ladder** — sell partial chunks at multiple profit tiers instead of one all-or-nothing exit, with stop-loss and a trailing-stop protecting whatever's left
- **Hold toggle** — freeze a specific position's automatic exits from the UI when you want to manage it by hand
- **Wallet nicknames** — label target wallets so the dashboard and Telegram alerts are readable
- **Telegram notifications** — buy/sell/exit alerts, plus a fast "callout-ready" alert when a live buy clears a USD threshold
- **Live dashboard** — open positions, PnL, copy log, and a live feed over a WebSocket, all served locally
- **Hard safety caps in live mode** — max position size, max total SOL at risk, and a minimum reserve, enforced in code before any transaction is built, independent of your strategy settings

## How it works

```
target wallet trades  →  gRPC detects it  →  entry filters (mcap/age/size)  →  copy buy
                                                                                    │
                                                        stop-loss / take-profit /  ◄┘
                                                        trailing-stop / ladder /
                                                        target-wallet sell (copy-sell)
                                                                    │
                                                                copy sell
```

1. **Detect** — subscribes to your target wallets over a Yellowstone gRPC feed and decodes their pump.fun/PumpSwap trades as they happen.
2. **Filter** — checks the trade against your global or per-wallet entry filters (mcap range, token age, target's own buy size) before deciding whether to copy it at all.
3. **Buy** — sizes the position per `POSITION_SIZE_SOL` (or a per-wallet override) and fills it — simulated in paper mode, a real signed transaction in live mode.
4. **Monitor** — polls the position's live price and checks stop-loss, take-profit, trailing-stop, ladder tiers, and (if `COPY_SELL` is on) whether the target wallet itself sold.
5. **Exit** — closes the position (fully or partially, for a ladder tier) the moment any exit condition fires, or you can close it manually from the dashboard at any time.

## Quick start

```bash
git clone https://github.com/1appwebmail/devmancodycopytraderv1.1.git
cd devmancodycopytraderv1.1
npm install
cp .env.example .env
```

Fill in `.env` — at minimum you need:
- **A gRPC source** — `PUBLICNODE_GRPC_ENDPOINT` works with no signup; `RPCFAST_GRPC_ENDPOINT`/`HELIUS_GRPC_ENDPOINT`/`RAIDEN_GRPC_ENDPOINT` are alternatives if you have your own credentials
- **`RPC_HTTP_URL`** — the public default works but rate-limits hard; a paid endpoint is much more reliable
- **`TARGET_WALLETS`** — comma-separated Solana addresses to copy

Then:

```bash
npm run serve
```

Open `http://localhost:4000` for the dashboard. It starts in `MODE=paper` (simulated, no real funds) by default — leave it there until you've watched it run for a while and are comfortable with how it behaves.

See [RUNNING.md](RUNNING.md) for the full operational guide — everyday commands, live-mode setup and safety checklist, diagnostic scripts, and a couple of real gotchas found the hard way.

## Configuration

Every setting is documented inline in [`.env.example`](.env.example) — copy it to `.env` and read the comments there rather than relying on this README to stay in sync with every option. The dashboard also lets you edit entry filters and per-wallet overrides live, without restarting.

## Safety notes

- **`MODE=live` submits real transactions with real SOL.** Don't set it until you've read [RUNNING.md's live-mode section](RUNNING.md#paper-vs-live-mode) and run `npm run live:dry-run` against a couple of real mints first — it simulates the exact instruction path with no funds spent.
- **Your private key never leaves your machine.** `LIVE_PRIVATE_KEY` is read from your local `.env` and used only to sign transactions locally — it is never transmitted anywhere by this code. Still, treat the machine running it accordingly (don't run it on shared/untrusted infrastructure, don't commit `.env`).
- **Start small.** `LIVE_MAX_POSITION_SOL`, `LIVE_MAX_TOTAL_SOL_AT_RISK`, and `LIVE_MIN_SOL_RESERVE` are hard caps enforced before any transaction is built — set them deliberately, not to whatever your wallet happens to hold.
- **This is not financial advice**, and copying a wallet's trades is not a guarantee of profit — a target wallet can lose money too, and execution latency/slippage means your fill is never identical to theirs.

## License

MIT — see [LICENSE](LICENSE). Use it, fork it, self-host it.
