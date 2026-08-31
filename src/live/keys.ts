import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

/** Loads the trading keypair from LIVE_PRIVATE_KEY — accepts either a base58-encoded secret key
 *  string (the format Phantom/Solflare export) or a JSON array of 64 numbers (the format
 *  `solana-keygen` writes). Optionally cross-checks the derived pubkey against LIVE_WALLET_ADDRESS
 *  if set, so a pasted-wrong key fails loudly at startup instead of silently trading from the
 *  wrong wallet. */
export function loadLiveKeypair(): Keypair {
  const raw = process.env.LIVE_PRIVATE_KEY;
  if (!raw || raw.trim() === "") {
    throw new Error("LIVE_PRIVATE_KEY is not set — required for MODE=live");
  }

  let keypair: Keypair;
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed) as number[];
    keypair = Keypair.fromSecretKey(Uint8Array.from(arr));
  } else {
    keypair = Keypair.fromSecretKey(bs58.decode(trimmed));
  }

  const expected = process.env.LIVE_WALLET_ADDRESS;
  if (expected && expected.trim() !== "") {
    const expectedPubkey = new PublicKey(expected.trim());
    if (!keypair.publicKey.equals(expectedPubkey)) {
      throw new Error(
        `LIVE_PRIVATE_KEY derives to ${keypair.publicKey.toBase58()}, which does not match LIVE_WALLET_ADDRESS=${expected.trim()} — refusing to start with a mismatched key.`,
      );
    }
  }

  return keypair;
}
