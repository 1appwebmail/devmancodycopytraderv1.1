// User-assigned nicknames for target wallets — purely a display label, never used for matching
// or filtering (TARGET_WALLETS addresses remain the actual source of truth for that). Persisted
// to disk so a restart doesn't lose them, same reasoning as walletFilters.json in settings.ts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const WALLET_NAMES_FILE = path.join(path.resolve(process.cwd(), "data"), "walletNames.json");

function load(): Map<string, string> {
  try {
    if (!existsSync(WALLET_NAMES_FILE)) return new Map();
    const parsed = JSON.parse(readFileSync(WALLET_NAMES_FILE, "utf8")) as Record<string, string>;
    return new Map(Object.entries(parsed));
  } catch (err) {
    console.error(`walletNames: failed to load ${WALLET_NAMES_FILE}, starting with no names:`, err);
    return new Map();
  }
}

const names = load();

function save(): void {
  try {
    const dir = path.dirname(WALLET_NAMES_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(WALLET_NAMES_FILE, JSON.stringify(Object.fromEntries(names)), "utf8");
  } catch (err) {
    console.error(`walletNames: failed to save ${WALLET_NAMES_FILE}:`, err);
  }
}

export function getAllWalletNames(): Record<string, string> {
  return Object.fromEntries(names);
}

export function setWalletName(wallet: string, name: string): void {
  const trimmed = name.trim();
  if (trimmed === "") {
    names.delete(wallet);
  } else {
    names.set(wallet, trimmed);
  }
  save();
}
