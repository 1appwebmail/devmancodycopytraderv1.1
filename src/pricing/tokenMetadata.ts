import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { BorshReader, decodeStruct, type Schema } from "../parsing/borsh.js";
import { TOKEN_METADATA_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "../constants.js";

// Legacy Metaplex Metadata account: fixed header, then a Borsh-encoded Data struct.
const LEGACY_METADATA_SCHEMA: Schema = [
  ["key", "u8"],
  ["update_authority", "pubkey"],
  ["mint", "pubkey"],
  ["name", "string"],
  ["symbol", "string"],
  ["uri", "string"],
] as const;

// Token-2022 Mint accounts pad the base 82-byte Mint struct out to 165 bytes (aliasing the
// legacy Token Account size), then a 1-byte AccountType marker at offset 165, then the TLV
// extension list begins at 166. Verified empirically against a live pump.fun Token-2022 mint.
const TOKEN_2022_TLV_START = 166;
const EXTENSION_TYPE_TOKEN_METADATA = 19;

function deriveLegacyMetadataPda(mint: string): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), new PublicKey(TOKEN_METADATA_PROGRAM_ID).toBuffer(), new PublicKey(mint).toBuffer()],
    new PublicKey(TOKEN_METADATA_PROGRAM_ID),
  );
  return pda;
}

/** Finds and decodes the TokenMetadata TLV extension embedded in a Token-2022 mint account, if present. */
function readToken2022Symbol(data: Buffer): string | null {
  let offset = TOKEN_2022_TLV_START;
  while (offset + 4 <= data.length) {
    const extType = data.readUInt16LE(offset);
    const extLen = data.readUInt16LE(offset + 2);
    const valueStart = offset + 4;
    if (extLen === 0 || valueStart + extLen > data.length) break; // padding/terminator or malformed
    if (extType === EXTENSION_TYPE_TOKEN_METADATA) {
      const reader = new BorshReader(data.subarray(valueStart, valueStart + extLen));
      reader.pubkey(); // update_authority
      reader.pubkey(); // mint
      reader.string(); // name
      return reader.string(); // symbol
    }
    offset = valueStart + extLen;
  }
  return null;
}

/** Caches each mint's ticker symbol, resolved from on-chain metadata (or pre-warmed from a CreateEvent). */
export class TokenMetadataCache {
  private cache = new Map<string, string>();
  private inFlight = new Map<string, Promise<string | null>>();

  constructor(private connection: Connection) {}

  set(mint: string, symbol: string) {
    const cleaned = symbol.replace(/\0/g, "").trim();
    if (cleaned) this.cache.set(mint, cleaned);
  }

  getCached(mint: string): string | null {
    return this.cache.get(mint) ?? null;
  }

  /** Snapshot of everything resolved so far, for handing to a freshly-connected client. */
  getAll(): Record<string, string> {
    return Object.fromEntries(this.cache);
  }

  async resolveSymbol(mint: string): Promise<string | null> {
    const cached = this.cache.get(mint);
    if (cached !== undefined) return cached;

    let pending = this.inFlight.get(mint);
    if (!pending) {
      pending = this.fetch(mint);
      this.inFlight.set(mint, pending);
    }
    const result = await pending;
    this.inFlight.delete(mint);
    return result;
  }

  private async fetch(mint: string): Promise<string | null> {
    try {
      const mintInfo = await this.connection.getAccountInfo(new PublicKey(mint));
      if (!mintInfo) return null;

      const symbol =
        mintInfo.owner.toBase58() === TOKEN_2022_PROGRAM_ID
          ? readToken2022Symbol(mintInfo.data)
          : await this.fetchLegacySymbol(mint);

      const cleaned = symbol?.replace(/\0/g, "").trim() ?? null;
      if (!cleaned) return null;
      this.cache.set(mint, cleaned);
      return cleaned;
    } catch (err) {
      console.error(`TokenMetadataCache: failed to resolve mint ${mint}:`, err);
      return null;
    }
  }

  private async fetchLegacySymbol(mint: string): Promise<string | null> {
    const pda = deriveLegacyMetadataPda(mint);
    const info: AccountInfo<Buffer> | null = await this.connection.getAccountInfo(pda);
    if (!info) return null;
    const data = decodeStruct<{ symbol: string }>(info.data, LEGACY_METADATA_SCHEMA);
    return data.symbol;
  }
}
