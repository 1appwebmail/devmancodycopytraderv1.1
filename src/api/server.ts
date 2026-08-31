import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { App } from "../app.js";
import { config } from "../config.js";
import { getSettings, updateSettings, getAllWalletSettings, setWalletSettings, clearWalletSettings, type FilterSettings } from "../settings.js";
import { getSolUsdPrice } from "../pricing/solUsd.js";
import { getAllWalletNames, setWalletName } from "../pricing/walletNames.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../../public");

function bigintSafeReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

function respondJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, bigintSafeReplacer));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const FILTER_KEYS = ["minMcapUsd", "maxMcapUsd", "minAgeSeconds", "maxAgeSeconds", "minTargetBuySol", "maxTargetBuySol"] as const;

/** Validates a request body's filter fields, returning only the keys actually present (so a
 *  partial patch and a full replacement can share the same validation). Returns an error string
 *  instead of throwing so callers can respond with a proper 400. */
function parseFilterFields(body: unknown): { patch: Record<string, number | null> } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "expected a JSON object" };
  const patch: Record<string, number | null> = {};
  for (const key of FILTER_KEYS) {
    if (key in body) {
      const value = (body as Record<string, unknown>)[key];
      if (value !== null && typeof value !== "number") return { error: `${key} must be a number or null` };
      patch[key] = value as number | null;
    }
  }
  return { patch };
}

/** Single source of truth for the "full state" payload — used by both GET /api/state and the
 *  WebSocket's initial push on connect. These used to be built separately and had drifted out of
 *  sync (the WS version was missing targetWallets/mode/startingBalanceSol); since the client's WS
 *  handler REPLACES its whole local state object with whichever of these arrives, any field
 *  present in one but not the other would vanish depending on which happened to land last. */
function buildFullStatePayload(app: App) {
  return {
    ...app.executor.getState(),
    startingBalanceSol: config.startingPaperBalanceSol,
    mode: config.mode,
    targetWallets: config.targetWallets,
    solUsdPrice: getSolUsdPrice(),
    symbols: app.tokenMetadata.getAll(),
    botName: config.botName,
  };
}

export function startApiServer(app: App) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        const html = await readFile(path.join(PUBLIC_DIR, "index.html"), "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && req.url === "/api/state") {
        respondJson(res, 200, buildFullStatePayload(app));
        return;
      }

      if (req.method === "GET" && req.url === "/api/settings") {
        respondJson(res, 200, getSettings());
        return;
      }

      if (req.method === "POST" && req.url === "/api/settings") {
        const parsed = parseFilterFields(await readJsonBody(req));
        if ("error" in parsed) {
          respondJson(res, 400, { error: parsed.error });
          return;
        }
        const updated = updateSettings(parsed.patch);
        broadcast("settings", updated);
        respondJson(res, 200, updated);
        return;
      }

      // Per-target-wallet filter overrides — a wallet with an entry here uses ITS OWN complete
      // filter set instead of the global one above (see settings.ts). GET returns all overrides
      // keyed by wallet address; POST sets/replaces one wallet's full filter set (unlike the
      // global PATCH-style endpoint above, this expects all six fields — the UI always sends a
      // complete set for a wallet, defaulting unfilled fields to the global values as a starting
      // point); DELETE removes the override, reverting that wallet to the global defaults.
      if (req.method === "GET" && req.url === "/api/settings/wallets") {
        respondJson(res, 200, getAllWalletSettings());
        return;
      }

      const walletSettingsMatch = req.url?.match(/^\/api\/settings\/wallets\/([^/]+)$/);
      if (walletSettingsMatch) {
        const wallet = decodeURIComponent(walletSettingsMatch[1]);
        if (req.method === "POST") {
          const parsed = parseFilterFields(await readJsonBody(req));
          if ("error" in parsed) {
            respondJson(res, 400, { error: parsed.error });
            return;
          }
          const merged: FilterSettings = { ...getSettings(), ...parsed.patch };
          const updated = setWalletSettings(wallet, merged);
          broadcast("walletSettings", { wallet, settings: updated });
          respondJson(res, 200, updated);
          return;
        }
        if (req.method === "DELETE") {
          clearWalletSettings(wallet);
          broadcast("walletSettings", { wallet, settings: null });
          respondJson(res, 200, { cleared: true });
          return;
        }
      }

      // Wallet nicknames — pure display labels, never used for matching/filtering (TARGET_WALLETS
      // addresses are still the real source of truth). GET returns all; POST sets/clears one (an
      // empty/blank name clears it, same convention as the filter inputs elsewhere in this UI).
      if (req.method === "GET" && req.url === "/api/wallet-names") {
        respondJson(res, 200, getAllWalletNames());
        return;
      }

      const walletNameMatch = req.method === "POST" && req.url?.match(/^\/api\/wallet-names\/([^/]+)$/);
      if (walletNameMatch) {
        const wallet = decodeURIComponent(walletNameMatch[1]);
        const body = await readJsonBody(req);
        const name = (body as Record<string, unknown>)?.name;
        if (typeof name !== "string") {
          respondJson(res, 400, { error: "expected { name: string }" });
          return;
        }
        setWalletName(wallet, name);
        const updated = getAllWalletNames();
        broadcast("walletNamesAll", updated);
        respondJson(res, 200, { wallet, name: updated[wallet] ?? null });
        return;
      }

      const closeMatch = req.method === "POST" && req.url?.match(/^\/api\/positions\/([^/]+)\/close$/);
      if (closeMatch) {
        const entry = await app.closePosition(closeMatch[1]);
        if (!entry) {
          respondJson(res, 404, { error: "position not found, already closed, or price unavailable" });
          return;
        }
        respondJson(res, 200, entry);
        return;
      }

      const holdMatch = req.method === "POST" && req.url?.match(/^\/api\/positions\/([^/]+)\/hold$/);
      if (holdMatch) {
        const body = await readJsonBody(req);
        const held = (body as Record<string, unknown>)?.held;
        if (typeof held !== "boolean") {
          respondJson(res, 400, { error: "expected { held: boolean }" });
          return;
        }
        const position = app.setPositionHold(holdMatch[1], held);
        if (!position) {
          respondJson(res, 404, { error: "position not found or already closed" });
          return;
        }
        respondJson(res, 200, position);
        return;
      }

      respondJson(res, 404, { error: "not found" });
    } catch (err) {
      console.error("API error:", err);
      respondJson(res, 500, { error: "internal error" });
    }
  });

  const wss = new WebSocketServer({ server, path: "/ws" });

  function broadcast(type: string, payload: unknown) {
    const msg = JSON.stringify({ type, payload }, bigintSafeReplacer);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(msg);
    }
  }

  app.on("status", (source, status, detail) => broadcast("status", { source, status, detail }));
  app.on("trade", (evt) => broadcast("trade", evt));
  app.on("create", (evt) => broadcast("create", evt));
  app.on("migration", (evt) => broadcast("migration", evt));
  app.on("buy", (position) => broadcast("buy", position));
  app.on("sell", (position, entry, reason) => broadcast("sell", { position, entry, reason }));
  app.on("copy", (payload) => broadcast("copy", payload));
  app.on("priceUpdate", (payload) => broadcast("priceUpdate", payload));
  app.on("symbol", (payload) => broadcast("symbol", payload));

  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "state", payload: buildFullStatePayload(app) }, bigintSafeReplacer));
    ws.send(JSON.stringify({ type: "settings", payload: getSettings() }, bigintSafeReplacer));
    ws.send(JSON.stringify({ type: "walletSettingsAll", payload: getAllWalletSettings() }, bigintSafeReplacer));
    ws.send(JSON.stringify({ type: "walletNamesAll", payload: getAllWalletNames() }, bigintSafeReplacer));
  });

  server.listen(config.apiPort, () => {
    console.log(`API server listening on http://localhost:${config.apiPort} (WS at /ws)`);
  });

  return server;
}
