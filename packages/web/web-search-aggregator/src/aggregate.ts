/**
 * The vendor-independent aggregator itself: a `WebSearchProvider` that runs
 * configured search engines in order and fails over transparently. The seam
 * contract (cancellation, `maxResults`, `WebError` vocabulary) is honored here;
 * engines never see the seam.
 * @module @deepseek-ai/dsh-web-search-aggregator/aggregate
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import { EngineError } from './engine.ts'
import type { SearchEngineAdapter } from './engine.ts'

/** A resolved source plus the cap decision, shared by the aggregator. */
interface SeenSources {
  /** Already-accepted sources, in engine order. */
  readonly sources: readonly WebSearchSource[]
  /** True when the aggregator truncated to honor `maxResults`. */
  readonly truncated: boolean
}

/** What running one engine produced, so the aggregator can fall back or report. */
type RunOutcome =
  | { readonly kind: 'ok'; readonly sources: readonly WebSearchSource[] }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'failed'; readonly message: string }

/**
 * Run one engine. Throws only for caller cancellation; every other outcome is
 * returned so the aggregator can fall back and, on total failure, say exactly
 * which engine failed and how. A clean-but-empty result is a fallback signal.
 */
async function runEngine(
  engine: SearchEngineAdapter,
  query: string,
  maxResults: number | undefined,
  signal: AbortSignal | undefined,
): Promise<RunOutcome> {
  if (!engine.available()) return { kind: 'skipped' }
  try {
    return {
      kind: 'ok',
      sources: await engine.search({
        query,
        ...maxResults !== undefined ? { maxResults } : {},
        ...signal !== undefined ? { signal } : {},
      }),
    }
  } catch (error: unknown) {
    if (error instanceof EngineError) return { kind: 'failed', message: `${engine.label}: ${error.message}` }
    // Cancellation is a caller problem, not an engine to skip — never fall back
    // across a genuine abort, and surface it in the seam's abort vocabulary.
    if (signal?.aborted === true || isAbortError(error)) {
      throw new WebError('web-search-aggregator search aborted', 'WEB_ABORTED', { cause: error })
    }
    throw error
  }
}

/** True for a fetch/`AbortSignal` abort. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Dedupe sources by URL (first occurrence wins) and cap to `maxResults`. */
function truncateAndDedupe(sources: readonly WebSearchSource[], maxResults: number | undefined): SeenSources {
  const seen = new Set<string>()
  const out: WebSearchSource[] = []
  for (const source of sources) {
    if (seen.has(source.url)) continue
    seen.add(source.url)
    if (maxResults !== undefined && out.length === maxResults) {
      return { sources: out, truncated: true }
    }
    out.push(source)
  }
  return { sources: out, truncated: false }
}

/**
 * Vendor-independent multi-engine search provider. Engines are tried in
 * configured order; the first to yield non-empty sources wins. A total failure —
 * every engine down or empty — surfaces one {@link WebError} naming every
 * engine's failure mode, so the model sees why search failed rather than a bare
 * retry loop.
 */
export class AggregateSearchProvider implements WebSearchProvider {
  readonly id: string

  /**
   * @param resolveEngines - resolves the adapter list for ONE operation,
   *   snapshotted once so the set of fallback engines never changes mid-search;
   *   a thunk (rather than a fixed array) so a settings-section edit re-routes
   *   the NEXT search without re-registering the provider.
   * @param providerId - stable seam id this provider registers under.
   */
  constructor(
    private readonly resolveEngines: () => readonly SearchEngineAdapter[],
    readonly providerId = 'web-search-aggregator',
  ) {
    this.id = providerId
  }

  /** Usable as long as at least one configured engine is available. */
  available(): boolean {
    return this.resolveEngines().some(engine => engine.available())
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const query = request.query
    const engines = this.resolveEngines()
    const failures: string[] = []
    for (const engine of engines) {
      const outcome = await runEngine(engine, query, request.maxResults, signal)
      if (outcome.kind === 'ok' && outcome.sources.length > 0) {
        const seen = truncateAndDedupe(outcome.sources, request.maxResults)
        return { sources: seen.sources, truncated: seen.truncated }
      }
      if (outcome.kind === 'ok') failures.push(`${engine.label}: no results`)
      if (outcome.kind === 'failed') failures.push(outcome.message)
    }
    if (failures.length === 0) {
      // Nothing was even available — a pure config condition.
      throw new WebError(
        'web-search-aggregator: no search engine is configured or available; '
        + 'enable at least one engine (e.g. duckduckgo or mojeek) or set its credential/baseURL',
        'WEB_PROVIDER_UNAVAILABLE',
      )
    }
    throw new WebError(
      `web-search-aggregator: every engine failed (${failures.join('; ')})`,
      'WEB_PROVIDER_ERROR',
    )
  }
}
