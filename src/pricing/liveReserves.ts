import { Connection, PublicKey } from "@solana/web3.js";
import { decodeStruct } from "../parsing/borsh.js";
import { BondingCurveAccountSchema } from "../parsing/schemas.js";
import { PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, WSOL_MINT } from "../constants.js";
import { PoolRegistry } from "../pools/registry.js";
import { withRetry } from "./withRetry.js";
import type { Reserves } from "../executor/paper.js";
import type { Position } from "../types.js";

const ANCHOR_ACCOUNT_DISCRIMINATOR_LEN = 8;
const SPL_TOKEN_AMOUNT_OFFSET = 64; // mint(32) + owner(32), then amount:u64
// Pool account layout (after the 8-byte discriminator): pool_bump(1) + index(2) + creator(32),
// then base_mint — verified against a real migrated pool's account data.
const POOL_BASE_MINT_OFFSET = ANCHOR_ACCOUNT_DISCRIMINATOR_LEN + 1 + 2 + 32;

export function deriveBondingCurve(mint: string): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()],
    new PublicKey(PUMP_PROGRAM_ID),
  );
  return pda;
}

interface BondingCurveState {
  reserves: Reserves;
  complete: boolean;
}

async function fetchBondingCurve(connection: Connection, mint: string): Promise<BondingCurveState | null> {
  try {
    const pda = deriveBondingCurve(mint);
    const info = await withRetry(() => connection.getAccountInfo(pda));
    if (!info) return null;
    const data = decodeStruct<{ virtual_quote_reserves: bigint; virtual_token_reserves: bigint; complete: boolean }>(
      info.data.subarray(ANCHOR_ACCOUNT_DISCRIMINATOR_LEN),
      BondingCurveAccountSchema,
    );
    return { reserves: { sol: BigInt(data.virtual_quote_reserves), token: BigInt(data.virtual_token_reserves) }, complete: data.complete };
  } catch (err) {
    console.error(`fetchBondingCurve: failed for mint ${mint}:`, err);
    return null;
  }
}

export async function getPumpfunReserves(connection: Connection, mint: string): Promise<Reserves | null> {
  const curve = await fetchBondingCurve(connection, mint);
  // A completed curve's virtual reserves are frozen at whatever they were at migration (often
  // zeroed out entirely) — verified against a real migrated mint, where trusting them produced a
  // false "100% loss, $0 price" result. Once complete, the real liquidity has moved to a PumpSwap
  // pool; see getReservesForPosition, which is what actually handles that handoff.
  if (!curve || curve.complete) return null;
  return curve.reserves;
}

/** Finds the PumpSwap pool for a mint that's graduated off the bonding curve — there's no
 *  deterministic address to derive (pool index/creator aren't fixed), so this scans PumpSwap's
 *  Pool accounts for one with base_mint === mint. Verified against a real migrated mint. */
export async function findPumpSwapPoolForMint(connection: Connection, mint: string): Promise<string | null> {
  try {
    const accounts = await withRetry(() =>
      connection.getProgramAccounts(new PublicKey(PUMP_AMM_PROGRAM_ID), {
        filters: [{ memcmp: { offset: POOL_BASE_MINT_OFFSET, bytes: mint } }],
      }),
    );
    return accounts[0]?.pubkey.toBase58() ?? null;
  } catch (err) {
    console.error(`findPumpSwapPoolForMint: failed for mint ${mint}:`, err);
    return null;
  }
}

/**
 * Reserves for a POSITION (not just a raw mint/pool) — the single entry point every caller should
 * use. Handles a pumpfun-venue position whose token has since migrated to PumpSwap while we were
 * still holding it (easy to hit with the Hold feature, which deliberately keeps a position open
 * far longer than usual): detects the completed bonding curve, finds the new PumpSwap pool, and
 * mutates the position's venue/pool in place so every downstream check (exits, manual close, live
 * PnL) keeps working transparently post-migration instead of pricing off a dead, zeroed-out curve.
 */
export async function getReservesForPosition(connection: Connection, position: Position, poolRegistry: PoolRegistry): Promise<Reserves | null> {
  if (position.venue === "pumpswap") {
    return position.pool ? getPumpswapReserves(connection, position.pool, poolRegistry) : null;
  }

  const curve = await fetchBondingCurve(connection, position.mint);
  if (curve && !curve.complete) return curve.reserves;

  const pool = await findPumpSwapPoolForMint(connection, position.mint);
  if (!pool) return null;

  console.log(`[migration] ${position.mint.slice(0, 8)}… bonding curve is complete — switching position ${position.id.slice(0, 8)}… to PumpSwap pool ${pool.slice(0, 8)}…`);
  position.venue = "pumpswap";
  position.pool = pool;
  return getPumpswapReserves(connection, pool, poolRegistry);
}

export async function getPumpswapReserves(
  connection: Connection,
  poolAddress: string,
  registry: PoolRegistry,
): Promise<Reserves | null> {
  try {
    const pool = await registry.resolve(poolAddress);
    if (!pool) return null;

    const accounts = await withRetry(() =>
      connection.getMultipleAccountsInfo([new PublicKey(pool.baseTokenAccount), new PublicKey(pool.quoteTokenAccount)]),
    );
    const [baseAccount, quoteAccount] = accounts;
    if (!baseAccount || !quoteAccount) return null;

    const baseBalance = baseAccount.data.readBigUInt64LE(SPL_TOKEN_AMOUNT_OFFSET);
    const quoteBalance = quoteAccount.data.readBigUInt64LE(SPL_TOKEN_AMOUNT_OFFSET);

    // Which side is SOL isn't fixed per pool — verified against live pools where base=SOL/
    // quote=token instead of the usual base=token/quote=SOL (see App/ingestion for the same
    // check). virtual_quote_reserves is structurally a quote-side adjustment, so it only gets
    // added to whichever balance is on the quote side, regardless of which asset that is.
    if (pool.quoteMint === WSOL_MINT) {
      return { sol: quoteBalance + pool.virtualQuoteReserves, token: baseBalance };
    }
    if (pool.baseMint === WSOL_MINT) {
      return { sol: baseBalance, token: quoteBalance + pool.virtualQuoteReserves };
    }
    console.error(`getPumpswapReserves: pool ${poolAddress} isn't SOL-denominated on either side (base=${pool.baseMint}, quote=${pool.quoteMint})`);
    return null;
  } catch (err) {
    console.error(`getPumpswapReserves: failed for pool ${poolAddress}:`, err);
    return null;
  }
}
