import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { App } from "../app.js";
import { config } from "../config.js";
import { getSettings, updateSettings } from "../settings.js";
import { getSolUsdPrice } from "../pricing/solUsd.js";

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

export function startApiServer(app: App) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
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
        const state = app.executor.getState();
        respondJson(res, 200, {
          ...state,
          startingBalanceSol: config.startingPaperBalanceSol,
          mode: config.mode,
          targetWallets: config.targetWallets,
          solUsdPrice: getSolUsdPrice(),
          symbols: app.tokenMetadata.getAll(),
          botName: config.botName,
        });
        return;
      }

      if (req.method === "GET" && req.url === "/api/settings") {
        respondJson(res, 200, getSettings());
        return;
      }

      if (req.method === "POST" && req.url === "/api/settings") {
        const body = await readJsonBody(req);
        if (typeof body !== "object" || body === null) {
          respondJson(res, 400, { error: "expected a JSON object" });
          return;
        }
        const allowedKeys = ["minMcapUsd", "maxMcapUsd", "minAgeSeconds", "maxAgeSeconds", "minTargetBuySol", "maxTargetBuySol"] as const;
        const patch: Record<string, number | null> = {};
        for (const key of allowedKeys) {
          if (key in body) {
            const value = (body as Record<string, unknown>)[key];
            if (value !== null && typeof value !== "number") {
              respondJson(res, 400, { error: `${key} must be a number or null` });
              return;
            }
            patch[key] = value as number | null;
          }
        }
        const updated = updateSettings(patch);
        broadcast("settings", updated);
        respondJson(res, 200, updated);
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
    ws.send(JSON.stringify({ type: "state", payload: { ...app.executor.getState(), solUsdPrice: getSolUsdPrice(), symbols: app.tokenMetadata.getAll(), botName: config.botName } }, bigintSafeReplacer));
    ws.send(JSON.stringify({ type: "settings", payload: getSettings() }, bigintSafeReplacer));
  });

  server.listen(config.apiPort, () => {
    console.log(`API server listening on http://localhost:${config.apiPort} (WS at /ws)`);
  });

  return server;
}
