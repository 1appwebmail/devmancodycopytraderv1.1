import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import type { SubscribeUpdateTransactionInfo } from "@triton-one/yellowstone-grpc";
import { decodePumpEvent, decodePumpAmmEvent } from "../parsing/decode.js";
import { PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, LAMPORTS_PER_SOL, NATIVE_SOL_SENTINEL, WSOL_MINT } from "../constants.js";
import type { TradeEvent, CreateEvent, MigrationEvent, RawPumpSwapTrade } from "../types.js";

export interface DecodedTx {
  trades: TradeEvent[];
  pumpSwapTrades: RawPumpSwapTrade[];
  creates: CreateEvent[];
  migrations: MigrationEvent[];
}

function resolveAccountKeys(info: SubscribeUpdateTransactionInfo): string[] {
  const message = info.transaction?.message;
  const meta = info.meta;
  const staticKeys = message?.accountKeys ?? [];
  const loadedWritable = meta?.loadedWritableAddresses ?? [];
  const loadedReadonly = meta?.loadedReadonlyAddresses ?? [];
  return [...staticKeys, ...loadedWritable, ...loadedReadonly].map((k) => new PublicKey(k).toBase58());
}

/** Decodes all Pump.fun / PumpSwap self-CPI events out of one gRPC transaction update. */
export function decodeTransaction(info: SubscribeUpdateTransactionInfo, slot: number): DecodedTx {
  const result: DecodedTx = { trades: [], pumpSwapTrades: [], creates: [], migrations: [] };
  const meta = info.meta;
  if (!meta || meta.err) return result;

  const signature = bs58.encode(info.signature);
  const accountKeys = resolveAccountKeys(info);

  for (const inner of meta.innerInstructions ?? []) {
    for (const ix of inner.instructions) {
      const programId = accountKeys[ix.programIdIndex];
      const data = Buffer.from(ix.data);

      if (programId === PUMP_PROGRAM_ID) {
        const evt = decodePumpEvent(data);
        if (!evt) continue;
        if (evt.name === "TradeEvent") {
          const d = evt.data as any;
          // Bonding curves aren't necessarily SOL-quoted (the pump program supports a
          // configurable quote_mint) — `sol_amount`/`virtual_sol_reserves` are only meaningful
          // when the quote asset actually is SOL. Ordinary SOL-quoted curves report quote_mint
          // as this all-zero/System Program sentinel (verified against live trade data), not
          // WSOL_MINT — but accept either. Anything else means an alternate quote asset we can't
          // price in SOL terms, so skip it rather than silently use garbage sol_amount data.
          if (d.quote_mint !== NATIVE_SOL_SENTINEL && d.quote_mint !== WSOL_MINT) continue;
          result.trades.push({
            signature,
            slot,
            timestamp: Number(d.timestamp),
            venue: "pumpfun",
            direction: d.is_buy ? "buy" : "sell",
            trader: d.user,
            mint: d.mint,
            solAmount: Number(d.sol_amount) / LAMPORTS_PER_SOL,
            tokenAmount: Number(d.token_amount),
            postSolReserves: BigInt(d.virtual_sol_reserves),
            postTokenReserves: BigInt(d.virtual_token_reserves),
          });
        } else if (evt.name === "CreateEvent") {
          const d = evt.data as any;
          result.creates.push({
            signature,
            slot,
            timestamp: Number(d.timestamp),
            mint: d.mint,
            bondingCurve: d.bonding_curve,
            creator: d.creator,
            name: d.name,
            symbol: d.symbol,
            totalSupplyRaw: BigInt(d.token_total_supply),
          });
        } else if (evt.name === "CompleteEvent") {
          const d = evt.data as any;
          result.migrations.push({
            signature,
            slot,
            timestamp: Number(d.timestamp),
            mint: d.mint,
            bondingCurve: d.bonding_curve,
          });
        }
      } else if (programId === PUMP_AMM_PROGRAM_ID) {
        const evt = decodePumpAmmEvent(data);
        if (!evt) continue;
        if (evt.name === "BuyEvent" || evt.name === "SellEvent") {
          const d = evt.data as any;
          const isBuyEvent = evt.name === "BuyEvent";
          // Which side (base or quote) is actually SOL isn't fixed per pool — it requires the
          // pool account, an async RPC lookup we can't do here. See ingestion/index.ts, which
          // resolves the pool and turns this into a proper (correctly-oriented) TradeEvent.
          result.pumpSwapTrades.push({
            signature,
            slot,
            timestamp: Number(d.timestamp),
            trader: d.user,
            pool: d.pool,
            isBuyEvent,
            baseAmount: Number(isBuyEvent ? d.base_amount_out : d.base_amount_in),
            quoteAmount: Number(isBuyEvent ? d.quote_amount_in : d.quote_amount_out),
            // NOTE: despite the field name, these are PRE-trade reserves for PumpSwap events
            // (verified — see src/parsing/verify_reserves_order_amm.ts).
            baseReservesPre: BigInt(d.pool_base_token_reserves),
            quoteReservesPre: BigInt(d.pool_quote_token_reserves),
          });
        }
      }
    }
  }

  return result;
}
