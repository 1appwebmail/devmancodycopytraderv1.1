import {
  ANCHOR_EVENT_IX_TAG,
  PUMP_EVENT_DISCRIMINATORS,
  PUMP_AMM_EVENT_DISCRIMINATORS,
} from "../constants.js";
import { decodeStruct } from "./borsh.js";
import {
  TradeEventSchema,
  CreateEventSchema,
  CompleteEventSchema,
  BuyEventSchema,
  SellEventSchema,
  CreatePoolEventSchema,
} from "./schemas.js";

export interface DecodedEvent {
  name: string;
  data: Record<string, unknown>;
}

/**
 * Decodes a self-CPI `emit_cpi!` instruction's raw data.
 * Layout: [8-byte ANCHOR_EVENT_IX_TAG][8-byte event discriminator][borsh payload]
 */
function decodeEmitCpiEvent(
  data: Buffer,
  discriminators: Record<string, Buffer>,
  schemas: Record<string, Parameters<typeof decodeStruct>[1]>,
): DecodedEvent | null {
  if (data.length < 16) return null;
  if (!data.subarray(0, 8).equals(ANCHOR_EVENT_IX_TAG)) return null;
  const disc = data.subarray(8, 16);
  for (const [name, expected] of Object.entries(discriminators)) {
    if (disc.equals(expected)) {
      const payload = data.subarray(16);
      return { name, data: decodeStruct(payload, schemas[name]) };
    }
  }
  return null;
}

export function decodePumpEvent(data: Buffer): DecodedEvent | null {
  return decodeEmitCpiEvent(data, PUMP_EVENT_DISCRIMINATORS, {
    TradeEvent: TradeEventSchema,
    CreateEvent: CreateEventSchema,
    CompleteEvent: CompleteEventSchema,
  });
}

export function decodePumpAmmEvent(data: Buffer): DecodedEvent | null {
  return decodeEmitCpiEvent(data, PUMP_AMM_EVENT_DISCRIMINATORS, {
    BuyEvent: BuyEventSchema,
    SellEvent: SellEventSchema,
    CreatePoolEvent: CreatePoolEventSchema,
  });
}
