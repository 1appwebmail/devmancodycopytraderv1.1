// Runtime-mutable trading filters, editable live from the UI. Seeded from .env on startup
// (see src/config.ts) so the values survive a restart instead of resetting to "no limit" every
// time — the UI can still change them mid-session same as before, it just no longer has to.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export interface FilterSettings {
  minMcapUsd: number | null;
  maxMcapUsd: number | null;
  minAgeSeconds: number | null;
  maxAgeSeconds: number | null;
  minTargetBuySol: number | null;
  maxTargetBuySol: number | null;
}

const settings: FilterSettings = {
  minMcapUsd: config.filterDefaults.minMcapUsd,
  maxMcapUsd: config.filterDefaults.maxMcapUsd,
  minAgeSeconds: config.filterDefaults.minAgeSeconds,
  maxAgeSeconds: config.filterDefaults.maxAgeSeconds,
  minTargetBuySol: config.filterDefaults.minTargetBuySol,
  maxTargetBuySol: config.filterDefaults.maxTargetBuySol,
};

const KEYS = ["minMcapUsd", "maxMcapUsd", "minAgeSeconds", "maxAgeSeconds", "minTargetBuySol", "maxTargetBuySol"] as const;

export function getSettings(): FilterSettings {
  return { ...settings };
}

export function updateSettings(patch: Partial<FilterSettings>): FilterSettings {
  for (const key of KEYS) {
    if (key in patch) {
      const value = patch[key];
      settings[key] = value === null || value === undefined || Number.isNaN(value) ? null : value;
    }
  }
  return getSettings();
}

export function isFilteringByMcap(s: FilterSettings = settings): boolean {
  return s.minMcapUsd !== null || s.maxMcapUsd !== null;
}

export function isFilteringByAge(s: FilterSettings = settings): boolean {
  return s.minAgeSeconds !== null || s.maxAgeSeconds !== null;
}

// --- Per-target-wallet filter overrides ---
// Different wallets genuinely trade differently (one might snipe brand-new launches at a $4-15K
// mcap, another might only buy proven $10-20K+ tokens 5-60 minutes in) — a single global filter
// tuned for one wallet's pattern silently filters out the other's entirely. A wallet with an entry
// here uses ITS OWN complete filter set instead of the global one; a wallet with no entry keeps
// using the global defaults exactly as before. Persisted to disk (same reasoning as state
// persistence — the whole point of a "startup default" is that a restart doesn't lose it) but
// deliberately NOT seeded from .env, since there's no reasonable way to express a variable number
// of per-wallet filter sets as environment variables.
const WALLET_SETTINGS_FILE = path.join(path.resolve(process.cwd(), "data"), "walletFilters.json");
const walletSettings = new Map<string, FilterSettings>(loadWalletSettings());

function loadWalletSettings(): [string, FilterSettings][] {
  try {
    if (!existsSync(WALLET_SETTINGS_FILE)) return [];
    const parsed = JSON.parse(readFileSync(WALLET_SETTINGS_FILE, "utf8")) as Record<string, FilterSettings>;
    return Object.entries(parsed);
  } catch (err) {
    console.error(`settings: failed to load ${WALLET_SETTINGS_FILE}, starting with no wallet overrides:`, err);
    return [];
  }
}

function saveWalletSettings(): void {
  try {
    const dir = path.dirname(WALLET_SETTINGS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(WALLET_SETTINGS_FILE, JSON.stringify(Object.fromEntries(walletSettings)), "utf8");
  } catch (err) {
    console.error(`settings: failed to save ${WALLET_SETTINGS_FILE}:`, err);
  }
}

/** The settings that actually apply to a specific target wallet's trade — their own saved
 *  override if they have one, otherwise the global defaults. This is what App.ts should always
 *  use when evaluating a trade FROM a specific wallet; getSettings() above is only the global
 *  fallback/default, not what necessarily applies to any given trade. */
export function getEffectiveSettings(wallet: string): FilterSettings {
  return walletSettings.get(wallet) ?? getSettings();
}

/** Null if this wallet has no override (i.e. is using the global defaults). */
export function getWalletSettings(wallet: string): FilterSettings | null {
  const s = walletSettings.get(wallet);
  return s ? { ...s } : null;
}

export function getAllWalletSettings(): Record<string, FilterSettings> {
  return Object.fromEntries(walletSettings);
}

export function setWalletSettings(wallet: string, newSettings: FilterSettings): FilterSettings {
  const normalized: FilterSettings = {} as FilterSettings;
  for (const key of KEYS) {
    const value = newSettings[key];
    normalized[key] = value === null || value === undefined || Number.isNaN(value) ? null : value;
  }
  walletSettings.set(wallet, normalized);
  saveWalletSettings();
  return { ...normalized };
}

/** Removes this wallet's override entirely — it goes back to using the global defaults. */
export function clearWalletSettings(wallet: string): void {
  walletSettings.delete(wallet);
  saveWalletSettings();
}
