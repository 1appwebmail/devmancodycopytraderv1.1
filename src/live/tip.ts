import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

const KNOWN_PROVIDERS = ["astralane", "bloxroute", "nozomi", "falcon"] as const;
export type BeamProvider = (typeof KNOWN_PROVIDERS)[number];

/**
 * Beam requires a client-built tip transfer instruction appended before signing — it does not
 * inject tips server-side. CRITICAL: tip accounts are PROVIDER-SPECIFIC — the address embedded in
 * your signed tx must belong to whichever provider you declare via the `provider=` query param on
 * the request (see submit.ts's getBeamProvider/sendViaBeam). Mixing a bloxroute tip account with
 * provider=astralane (etc.) will likely be rejected or silently misroute.
 *
 * Set BEAM_PROVIDER to one of astralane/bloxroute/nozomi/falcon, and LIVE_BEAM_TIP_ACCOUNTS to
 * THAT SAME PROVIDER's own tip account list (comma-separated). This project does not hardcode any
 * tip addresses — get the current list for your chosen provider from your rpcfast dashboard or
 * support before your live session, since these can change and were not fully verifiable from
 * public docs alone at the time this was written.
 */
export function buildBeamTipIx(payer: PublicKey): TransactionInstruction | null {
  const accountsRaw = process.env.LIVE_BEAM_TIP_ACCOUNTS;
  if (!accountsRaw || accountsRaw.trim() === "") return null;

  const accounts = accountsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (accounts.length === 0) return null;

  const tipAccount = new PublicKey(accounts[Math.floor(Math.random() * accounts.length)]!);
  // rpcfast's docs specify a 0.001 SOL minimum tip — default set a bit above that as a safety
  // margin rather than exactly on the boundary.
  const lamports = Number(process.env.LIVE_BEAM_TIP_LAMPORTS || "1200000");

  return SystemProgram.transfer({ fromPubkey: payer, toPubkey: tipAccount, lamports });
}

/** Which Beam provider to route through — required as a `provider=` query param on every Beam
 *  request (confirmed from rpcfast's docs), and must match whichever tip accounts are configured. */
export function getBeamProvider(): BeamProvider | null {
  const raw = (process.env.BEAM_PROVIDER || "").trim().toLowerCase();
  if (!raw) return null;
  if (!(KNOWN_PROVIDERS as readonly string[]).includes(raw)) {
    throw new Error(`BEAM_PROVIDER="${raw}" is not one of: ${KNOWN_PROVIDERS.join(", ")}`);
  }
  return raw as BeamProvider;
}
