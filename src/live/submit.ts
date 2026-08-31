import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { buildBeamTipIx, getBeamProvider } from "./tip.js";

export interface SubmitResult {
  signature: string;
  confirmed: boolean;
  error?: string;
}

/**
 * Assembles, signs, and submits a transaction built from `instructions`. Appends a compute-budget
 * priority fee and (if LIVE_BEAM_TIP_ACCOUNTS is configured) a Beam tip instruction before signing
 * — both must be part of the signed message, not bolted on after.
 *
 * Submission path: if BEAM_HTTP_URL is set, sends via Beam's JSON-RPC `sendTransaction` first
 * (base64-encoded, over HTTPS) for SWQoS-prioritized landing; otherwise (or if that call itself
 * fails, e.g. network error) falls back to the plain `connection.sendRawTransaction`. Beam is
 * documented to ignore `maxRetries`/`skipPreflight`-style params and not auto-retry, so this polls
 * confirmation itself and resends periodically rather than trusting either RPC to retry for it.
 *
 * Beam auth: rpcfast's own dashboard-issued URLs embed the key as a `?api_key=` query param (what
 * BEAM_HTTP_URL is set to in this project's .env); their public docs separately describe an
 * `X-Token` header. Both are sent — the query param because it's what the dashboard itself gave
 * the user, the header because the docs say so — since which one is actually checked wasn't fully
 * verifiable from public docs alone. Confirm with rpcfast directly if Beam sends aren't landing.
 */
export async function buildSignAndSubmit(
  connection: Connection,
  payer: Keypair,
  instructions: TransactionInstruction[],
  opts: { computeUnitLimit?: number; computeUnitPriceMicroLamports?: number; confirmTimeoutMs?: number; resendIntervalMs?: number } = {},
): Promise<SubmitResult> {
  const computeIxs: TransactionInstruction[] = [];
  if (opts.computeUnitLimit) computeIxs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnitLimit }));
  if (opts.computeUnitPriceMicroLamports) computeIxs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.computeUnitPriceMicroLamports }));

  const tipIx = buildBeamTipIx(payer.publicKey);
  const allIxs = [...computeIxs, ...instructions, ...(tipIx ? [tipIx] : [])];

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: allIxs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  const rawTx = tx.serialize();
  const signature = bufferToBase58Signature(tx.signatures[0]!);

  const send = async () => {
    const beamUrl = process.env.BEAM_HTTP_URL;
    if (beamUrl && beamUrl.trim() !== "") {
      try {
        await sendViaBeam(beamUrl.trim(), getBeamProvider(), rawTx);
        return;
      } catch (err) {
        console.error("submit: Beam send failed, falling back to plain RPC:", err);
      }
    }
    await connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 });
  };

  await send();

  const confirmTimeoutMs = opts.confirmTimeoutMs ?? 45_000;
  const resendIntervalMs = opts.resendIntervalMs ?? 5_000;
  const deadline = Date.now() + confirmTimeoutMs;
  let lastResend = Date.now();

  while (Date.now() < deadline) {
    const { value: statuses } = await connection.getSignatureStatuses([signature]);
    const status = statuses[0];
    if (status?.err) {
      return { signature, confirmed: false, error: JSON.stringify(status.err) };
    }
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
      return { signature, confirmed: true };
    }

    const height = await connection.getBlockHeight("confirmed").catch(() => null);
    if (height !== null && height > lastValidBlockHeight) {
      return { signature, confirmed: false, error: "blockhash expired before confirmation" };
    }

    if (Date.now() - lastResend >= resendIntervalMs) {
      lastResend = Date.now();
      await send().catch((err) => console.error("submit: resend failed:", err));
    }

    await new Promise((r) => setTimeout(r, 1_000));
  }

  return { signature, confirmed: false, error: "confirmation timed out" };
}

function bufferToBase58Signature(sig: Uint8Array): string {
  return bs58.encode(sig);
}

async function sendViaBeam(baseUrl: string, provider: string | null, rawTx: Uint8Array): Promise<void> {
  const url = new URL(baseUrl);
  if (provider) url.searchParams.set("provider", provider);

  const headers: Record<string, string> = { "content-type": "application/json" };
  const apiKey = process.env.BEAM_API_KEY || url.searchParams.get("api_key");
  if (apiKey) headers["x-token"] = apiKey;

  const res = await fetch(url.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [Buffer.from(rawTx).toString("base64"), { encoding: "base64", skipPreflight: true }],
    }),
  });
  if (!res.ok) throw new Error(`Beam sendTransaction HTTP ${res.status}`);
  const json = (await res.json()) as { error?: { message: string } };
  if (json.error) throw new Error(`Beam sendTransaction error: ${json.error.message}`);
}
