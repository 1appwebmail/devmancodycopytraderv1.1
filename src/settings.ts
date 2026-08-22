// Runtime-mutable trading filters, editable live from the UI. Seeded from .env on startup
// (see src/config.ts) so the values survive a restart instead of resetting to "no limit" every
// time — the UI can still change them mid-session same as before, it just no longer has to.
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

export function isFilteringByMcap(): boolean {
  return settings.minMcapUsd !== null || settings.maxMcapUsd !== null;
}

export function isFilteringByAge(): boolean {
  return settings.minAgeSeconds !== null || settings.maxAgeSeconds !== null;
}
