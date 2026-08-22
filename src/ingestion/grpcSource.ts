import Client, {
  CommitmentLevel,
  type SubscribeRequest,
  type SubscribeUpdateTransactionInfo,
} from "@triton-one/yellowstone-grpc";

export interface GrpcSourceOptions {
  name: string;
  endpoint: string;
  token?: string;
  targetWallets: string[];
  onTransaction: (info: SubscribeUpdateTransactionInfo, slot: number, source: string) => void;
  onStatus?: (source: string, status: "connected" | "disconnected" | "error", detail?: string) => void;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/** Connects to one Yellowstone gRPC source and reconnects with backoff on drop. */
export function startGrpcSource(opts: GrpcSourceOptions): void {
  let backoff = RECONNECT_BASE_MS;
  let stopped = false;

  async function run() {
    while (!stopped) {
      try {
        const client = new Client(opts.endpoint, opts.token, undefined);
        const stream = await client.subscribe();

        const request: SubscribeRequest = {
          accounts: {},
          slots: {},
          transactions: {
            client: {
              vote: false,
              failed: false,
              accountInclude: opts.targetWallets,
              accountExclude: [],
              accountRequired: [],
            },
          },
          transactionsStatus: {},
          blocks: {},
          blocksMeta: {},
          entry: {},
          accountsDataSlice: [],
          commitment: CommitmentLevel.PROCESSED,
        };

        await new Promise<void>((resolve, reject) => {
          stream.write(request as any, (err: Error | null | undefined) => {
            if (err) reject(err);
          });

          stream.on("data", (update: any) => {
            backoff = RECONNECT_BASE_MS;
            if (update.transaction?.transaction) {
              opts.onTransaction(update.transaction.transaction, Number(update.transaction.slot), opts.name);
            }
          });

          stream.on("error", (err: Error) => {
            opts.onStatus?.(opts.name, "error", err.message);
            reject(err);
          });

          stream.on("end", () => {
            opts.onStatus?.(opts.name, "disconnected", "stream ended");
            reject(new Error("stream ended"));
          });

          opts.onStatus?.(opts.name, "connected");
        });
      } catch (err) {
        opts.onStatus?.(opts.name, "error", err instanceof Error ? err.message : String(err));
      }

      if (stopped) return;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    }
  }

  run();
}
