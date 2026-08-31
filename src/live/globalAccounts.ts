import { Connection } from "@solana/web3.js";
import { decodeStruct } from "../parsing/borsh.js";
import { GlobalAccountSchema, GlobalConfigAccountSchema } from "../parsing/schemas.js";
import { deriveGlobal, deriveGlobalConfig } from "./pda.js";
import { withRetry } from "../pricing/withRetry.js";

const ANCHOR_ACCOUNT_DISCRIMINATOR_LEN = 8;

let cachedFeeRecipient: string | null = null;
let cachedProtocolFeeRecipient: string | null = null;

/**
 * pump.fun's active fee recipient — read from Global.fee_recipients[0] (a 7-slot rotation array),
 * NOT the legacy Global.fee_recipient singleton field, which is no longer used by real trades
 * (verified against live TradeEvents: the singleton matched 0/7 real samples, while values from
 * the array matched all of them). Any of the 7 slots is a valid recipient the program will accept.
 */
export async function getPumpFunFeeRecipient(connection: Connection): Promise<string> {
  if (cachedFeeRecipient) return cachedFeeRecipient;
  const info = await withRetry(() => connection.getAccountInfo(deriveGlobal()));
  if (!info) throw new Error("pump.fun Global account not found — can't resolve fee_recipient");
  const data = decodeStruct<{ fee_recipients: string[] }>(info.data.subarray(ANCHOR_ACCOUNT_DISCRIMINATOR_LEN), GlobalAccountSchema);
  const recipient = data.fee_recipients[0];
  if (!recipient) throw new Error("pump.fun Global.fee_recipients[0] is empty");
  cachedFeeRecipient = recipient;
  return cachedFeeRecipient;
}

/** PumpSwap's GlobalConfig.protocol_fee_recipients[0] — same idea, one of 8 valid recipients; index 0 is the conventional choice. */
export async function getPumpSwapProtocolFeeRecipient(connection: Connection): Promise<string> {
  if (cachedProtocolFeeRecipient) return cachedProtocolFeeRecipient;
  const info = await withRetry(() => connection.getAccountInfo(deriveGlobalConfig()));
  if (!info) throw new Error("PumpSwap GlobalConfig account not found — can't resolve protocol_fee_recipient");
  const data = decodeStruct<{ protocol_fee_recipients: string[] }>(info.data.subarray(ANCHOR_ACCOUNT_DISCRIMINATOR_LEN), GlobalConfigAccountSchema);
  const recipient = data.protocol_fee_recipients[0];
  if (!recipient) throw new Error("PumpSwap GlobalConfig.protocol_fee_recipients[0] is empty");
  cachedProtocolFeeRecipient = recipient;
  return cachedProtocolFeeRecipient;
}
