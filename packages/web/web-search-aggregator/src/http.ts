/**
 * Minimal HTTP helper for engine adapters: one `fetch` with a browser-ish UA,
 * byte-text decoding, and abort-aware failure classification into {@link EngineError}.
 * @module @deepseek-ai/dsh-web-search-aggregator/http
 */

import { EngineError } from './engine.ts'

/** A fetched body plus its status, already decoded to text. */
export interface FetchedBody {
  readonly ok: boolean
  readonly status: number
  readonly text: string
}

/** Browser-ish UA so keyless search engines do not reject the fetch as a bare script. */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/**
 * GET `url` and decode it to text. Throws {@link EngineError} on network
 * failure (unless `signal` already aborted, which is rethrown so the caller can
 * surface cancellation, never a skipped engine) and provides the raw status so
 * adapters classify blocks and rate limits.
 */
export async function fetchBody(url: string, signal: AbortSignal | undefined, headers: Record<string, string> = {}): Promise<FetchedBody> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      ...signal !== undefined ? { signal } : {},
      headers: { 'user-agent': USER_AGENT, 'accept': 'text/html,application/xhtml+xml,*/*;q=0.8', ...headers },
    })
  } catch (error: unknown) {
    if (signal?.aborted === true) throw error
    throw new EngineError('http', `network failure: ${String(error)}`)
  }
  const text = await response.text()
  return { ok: response.ok, status: response.status, text }
}

/** Classify a non-2xx status into an {@link EngineError} behind a request body already received. */
export function httpError(label: string, status: number): EngineError {
  if (status === 429) return new EngineError('limit', `${label} rate-limited (HTTP 429)`, status)
  if (status === 403 || status === 451) return new EngineError('blocked', `${label} blocked the request (HTTP ${status})`, status)
  return new EngineError('http', `${label} responded HTTP ${status}`, status)
}
