/**
 * Retries a flaky RPC call with short exponential backoff. Public/free Solana RPC endpoints
 * routinely return 429s under load — without a retry, every resolver built on `getAccountInfo`/
 * `getSignaturesForAddress` (mint supply, token age, live reserves, etc.) fails outright on the
 * first rate-limit hit, which silently makes any filter that depends on it skip trades it
 * shouldn't. Kept short (3 tries, capped under a second total) so it never meaningfully delays
 * a copy trade even in the worst case.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 150): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** i));
      }
    }
  }
  throw lastErr;
}
