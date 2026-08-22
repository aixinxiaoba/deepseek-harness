/**
 * Engine adapter surface for the aggregator search provider. Every backend
 * (keyless HTML scrapers, a self-hosted SearXNG instance, or a commercial API)
 * exposes the same narrow contract; the aggregator owns failover, dedup, the
 * result cap, and cancellation so a failing or blocked engine never fails a
 * search while another backend is still live.
 * @module @deepseek-ai/dsh-web-search-aggregator/engine
 */

import type { WebSearchSource } from '@deepseek-ai/dsh-web'

/** Input one engine adapter is asked to search. */
export interface EngineSearchInput {
  readonly query: string
  /** Upper bound on sources the caller wants; adapters may use it as a hint. */
  readonly maxResults?: number
  /** Cancellation signal forwarded to the engine's network call. */
  readonly signal?: AbortSignal
}

/** Why an engine failed, so the aggregator can explain a total failure honestly. */
export type EngineFailureReason = 'http' | 'blocked' | 'parse' | 'empty' | 'limit'

/** A typed engine failure. Thrown by {@link SearchEngineAdapter.search}. */
export class EngineError extends Error {
  readonly reason: EngineFailureReason
  readonly status: number | undefined

  constructor(reason: EngineFailureReason, message: string, status?: number) {
    super(message)
    this.name = 'EngineError'
    this.reason = reason
    this.status = status
  }
}

/**
 * One search backend. `available()` is a cheap local check (no network) that
 * decides whether this engine takes part in the aggregator's fallback chain —
 * for a commercial API, that means its credential is present, so an unconfigured
 * adapter is transparently skipped rather than tried and refused.
 */
export interface SearchEngineAdapter {
  /** Stable id (e.g. `duckduckgo`) used in config and diagnostics. */
  readonly id: string
  /** Human label for error messages (e.g. "DuckDuckGo"). */
  readonly label: string
  /** Cheap, network-free usability check. */
  available(): boolean
  /**
   * Run one search. Returns extracted sources; throws {@link EngineError} on
   * failure. Returning an empty array means "no results" (a valid page with
   * nothing matched), which the aggregator treats as a fallback signal.
   */
  search(input: EngineSearchInput): Promise<WebSearchSource[]>
}
