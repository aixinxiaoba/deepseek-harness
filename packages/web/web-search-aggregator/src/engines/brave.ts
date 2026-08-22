/**
 * Brave Search API engine (commercial row). Brave runs its own independent index
 * (not Google-derived) exposed via a clean JSON API — the industry-standard
 * "structured results with an SLA" choice. Active only when a key is present, so
 * an unconfigured deployment transparently skips it.
 * @module @deepseek-ai/dsh-web-search-aggregator/engines/brave
 */

import type { WebSearchSource } from '@deepseek-ai/dsh-web'
import { EngineError } from '../engine.ts'
import type { EngineSearchInput, SearchEngineAdapter } from '../engine.ts'
import type { KeyGetter } from './types.ts'
import { fetchBody, httpError } from '../http.ts'

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

interface BraveItem {
  url?: string
  title?: string
  description?: string
}

interface BraveResponse {
  web?: { results?: BraveItem[] }
}

function parseResults(json: BraveResponse): WebSearchSource[] {
  const sources: WebSearchSource[] = []
  for (const item of json.web?.results ?? []) {
    if (item.url === undefined || item.url.length === 0) continue
    sources.push({
      url: item.url,
      ...item.title !== undefined && item.title.length > 0 ? { title: item.title } : {},
      ...item.description !== undefined && item.description.length > 0 ? { snippet: item.description } : {},
    })
  }
  return sources
}

/** Brave Search API engine adapter, active when `BRAVE_API_KEY` is present. */
export class BraveEngine implements SearchEngineAdapter {
  readonly id = 'brave'
  readonly label = 'Brave'

  constructor(private readonly key: KeyGetter) {}

  available(): boolean {
    const key = this.key()
    return key !== undefined && key.length > 0
  }

  async search(input: EngineSearchInput): Promise<WebSearchSource[]> {
    const apiKey = this.key()
    if (apiKey === undefined || apiKey.length === 0) {
      throw new EngineError('http', `${this.label} engine is unavailable without an API key`)
    }
    const count = input.maxResults ?? 20
    const url = `${ENDPOINT}?q=${encodeURIComponent(input.query)}&count=${count}`
    const body = await fetchBody(url, input.signal, {
      'X-Subscription-Token': apiKey,
      'accept': 'application/json',
    })
    if (!body.ok) throw httpError(this.label, body.status)
    let json: BraveResponse
    try {
      json = JSON.parse(body.text) as BraveResponse
    } catch {
      throw new EngineError('parse', `${this.label} returned non-JSON output`)
    }
    return parseResults(json)
  }
}
