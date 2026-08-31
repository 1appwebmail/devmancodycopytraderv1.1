import type { Position, TradeLogEntry, Venue } from "../types.js";
import type { PaperState, Reserves } from "./paper.js";

/** Common shape implemented by both PaperExecutor and LiveExecutor — lets App.ts and
 *  PositionMonitor stay agnostic to which mode is running. */
export interface Executor {
  buy(mint: string, venue: Venue, solAmount: number, reserves: Reserves, pool?: string): Promise<Position | null>;
  sell(positionId: string, reserves: Reserves, reason: Position["exitReason"], fraction?: number): Promise<TradeLogEntry | null>;
  refreshBalance(): Promise<void>;
  getState(): PaperState;
}
