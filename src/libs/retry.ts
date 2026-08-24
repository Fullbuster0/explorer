/**
 * Retry with exponential backoff + jitter.
 *
 * Replaces the 14 copy-paste `for (attempt) { setTimeout(600*(attempt+1)) }`
 * blocks scattered across gno-tokens, gno-realms, gno-tx, account, tx, block,
 * and validator pages. Centralising the pattern means a single place to tune
 * delays and guarantees jitter so concurrent retries don't thundering-herd
 * a recovering endpoint.
 *
 * Delay formula:  baseDelay * 2^attempt + random(0, baseDelay/2)
 * Example (baseDelay=500): 500-750ms → 1000-1250ms → 2000-2250ms
 *
 * @param fn          Async factory — called fresh each attempt.
 * @param maxAttempts Total attempts (default 3 = 1 initial + 2 retries).
 * @param baseDelayMs Base delay for exponential backoff (default 500ms).
 * @param onRetry     Optional callback fired before each retry (for logging).
 * @returns           The resolved value of fn() on the first successful attempt.
 * @throws            The last error if all attempts fail.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 500,
  onRetry?: (attempt: number, error: unknown) => void,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts - 1) {
        if (onRetry) {
          try {
            onRetry(attempt + 1, e);
          } catch {
            /* callback error must not abort retry */
          }
        }
        const delay = baseDelayMs * Math.pow(2, attempt);
        const jitter = Math.random() * (baseDelayMs * 0.5);
        await new Promise((r) => setTimeout(r, delay + jitter));
      }
    }
  }
  throw lastErr;
}
