// Verified against pump-fun/pump-public-docs IDL (fetched 2026-08-18)
// https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json
// https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json
export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

// Metaplex Token Metadata program — pump.fun creates a standard metadata account for every
// mint at launch (it's one of the accounts in the `create` instruction), so this works for
// essentially any pump.fun/PumpSwap token, not just ones we happened to see a CreateEvent for.
export const TOKEN_METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

// Newer pump.fun mints are Token-2022 (not legacy SPL Token) and carry their metadata as a TLV
// extension embedded directly in the mint account — see src/pricing/tokenMetadata.ts.
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// Anchor emit_cpi! prefixes every self-invoked event instruction with this
// fixed 8-byte tag before the event's own 8-byte discriminator.
export const ANCHOR_EVENT_IX_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

export const PUMP_EVENT_DISCRIMINATORS = {
  CreateEvent: Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]),
  TradeEvent: Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]),
  CompleteEvent: Buffer.from([95, 114, 97, 156, 212, 46, 152, 8]),
  CompletePumpAmmMigrationEvent: Buffer.from([189, 233, 93, 185, 92, 148, 234, 148]),
} as const;

export const PUMP_AMM_EVENT_DISCRIMINATORS = {
  BuyEvent: Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]),
  SellEvent: Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]),
  CreatePoolEvent: Buffer.from([177, 49, 12, 210, 160, 118, 167, 116]),
} as const;

export const LAMPORTS_PER_SOL = 1_000_000_000;

// pump.fun's Global.token_total_supply — a fixed protocol-wide constant applied to every standard
// `create` call (verified directly against the live Global account: 1_000_000_000_000_000 raw
// units = 1B tokens @ 6 decimals). Used as an instant default for mcap filtering on the live-copy
// hot path, skipping a real RPC round trip (MintInfoCache.resolveTotalSupply) that was previously
// costing ~0.5-1s per trade decision — verified via [timing] log instrumentation during live
// testing. A non-standard mint (mayhem mode, or if pump.fun changes this constant) could have a
// different real supply, making mcap slightly inaccurate for that one trade — an acceptable
// tradeoff for a live copy-trading decision, where missing/mistiming the trade from slowness costs
// far more than a slightly-off mcap filter reading.
export const PUMP_STANDARD_TOKEN_SUPPLY_RAW = 1_000_000_000_000_000n;

// Wrapped SOL's mint address — PumpSwap pools can have either side (base or quote) be the actual
// SOL leg; there's no fixed convention, so every pool must be checked against this rather than
// assumed. See src/pools/registry.ts, src/pricing/liveReserves.ts, src/ingestion/index.ts.
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
// pump.fun's TradeEvent.quote_mint uses this all-zero/System Program sentinel for "native SOL"
// (not WSOL_MINT) on ordinary SOL-quoted bonding curves — verified against live trade data.
export const NATIVE_SOL_SENTINEL = "11111111111111111111111111111111";
