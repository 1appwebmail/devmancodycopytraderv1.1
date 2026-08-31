# Running pump-copytrader locally

## First-time setup

```bash
npm install
cp .env.example .env
```

Then fill in `.env` — see the comments in `.env.example` for what each variable does and why. At minimum you need:
- At least one gRPC source (`PUBLICNODE_GRPC_ENDPOINT` works with no signup, or `RPCFAST_GRPC_ENDPOINT`/`HELIUS_GRPC_ENDPOINT`/`RAIDEN_GRPC_ENDPOINT` with your own credentials)
- `RPC_HTTP_URL` (the public default works but rate-limits hard — a paid endpoint is much more reliable)
- `TARGET_WALLETS` — comma-separated wallet addresses to copy

**If using Raiden Vortex specifically:** its auth is IP-whitelist based, not a token — you register your machine's IP on Raiden's dashboard, not in `.env`. This matters most if you ever move to a different machine (see the section below) — the new machine's IP needs registering with Raiden too, separately from copying `.env` over, or the gRPC connection will be rejected even with a perfectly correct `.env`.

## Everyday commands

```bash
npm run serve      # bot + API/UI server, http://localhost:4000
npm run watch       # bot only, console output, no UI
npm test            # unit tests (pure logic, no network)
npx tsc --noEmit -p .   # typecheck
```

Always typecheck (and run `npm test` if you touched strategy/executor/positionManager logic) before starting the bot with real config changes — catches mistakes for free before they reach the network.

## Paper vs live mode

`MODE=paper` (default) simulates fills in memory — no real transactions, safe to experiment freely.

`MODE=live` submits real transactions with real SOL. Before ever setting this:
1. Set `LIVE_PRIVATE_KEY` (and optionally `LIVE_WALLET_ADDRESS` — startup verifies they match, so a pasted-wrong key fails loudly instead of silently trading from an unexpected wallet).
2. Set the `LIVE_*` safety caps deliberately — `LIVE_MAX_POSITION_SOL`, `LIVE_MAX_TOTAL_SOL_AT_RISK`, `LIVE_MIN_SOL_RESERVE`. These are enforced in code before any transaction is built, independent of `POSITION_SIZE_SOL`/`MAX_CONCURRENT_POSITIONS` (which apply in both modes — `POSITION_SIZE_SOL` must be ≤ `LIVE_MAX_POSITION_SOL` or startup refuses to run).
3. Fund the wallet with a bit more than `LIVE_MAX_TOTAL_SOL_AT_RISK + LIVE_MIN_SOL_RESERVE` — buys also cost a small ATA-creation rent (~0.002 SOL, one-time per new token) plus transaction fees.
4. **Run `npm run live:dry-run <mint> [solAmount]` against a couple of real, currently-active mints first.** This simulates the exact real instruction path via `simulateTransaction` — no funds spent, nothing broadcast — and is the cheapest way to catch a broken config before it costs money. It needs a real, funded wallet to simulate past Solana's fee-payer-must-exist check.
5. Only then set `MODE=live` and restart.

## Beam (rpcfast SWQoS) — optional

If `BEAM_HTTP_URL` is set, live submissions try Beam first (for prioritized landing) and fall back to plain RPC automatically if it fails — so it's safe to leave misconfigured, just slower. `BEAM_PROVIDER` must match whichever provider's addresses are in `LIVE_BEAM_TIP_ACCOUNTS` (each of astralane/bloxroute/nozomi/falcon has its own distinct tip account list — mixing them will misroute).

## Restarting cleanly (Windows-specific gotcha)

Stopping the bot process (however you started it — Ctrl+C in its terminal is the normal way) doesn't always fully kill the underlying `node.exe` on Windows if it was launched through a wrapper (e.g. `npm run serve` via some shells/task runners) — a stopped wrapper can leave the actual node process running, which risks **two live-trading instances running simultaneously** if you start a fresh one without checking. Before restarting after a change:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*pump-copytrader*" }
```

If anything shows up, stop it before starting a new instance. Confirm port 4000 is free too:

```powershell
Get-NetTCPConnection -LocalPort 4000 -ErrorAction SilentlyContinue
```

## Diagnostic scripts

```bash
npm run live:dry-run <mint> [solAmount]        # simulate a real live buy, no funds spent
npm run live:verify-fee-recipients             # cross-checks derived fee recipients against real on-chain trade data
```

Live logs include a `[timing]` line on every buy attempt (`detection=...ms filters=...ms reserves=...ms submit+confirm=...ms total=...ms`) — useful for diagnosing whether a bad fill came from slow detection/filtering (before submission) vs. slow submission/confirmation (after), since they need different fixes.

## Files that matter but aren't committed

- `.env` — your real config/secrets (gitignored)
- `data/state.paper.json`, `data/state.live.json` — persisted balance/positions/trades per mode, survives restarts (gitignored)
- `backups/` — manual `.env` snapshots, if you keep any (gitignored)
