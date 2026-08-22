/**
 * SearXNG engine: a self-hosted metasearch aggregator that fuses many upstreams
 * (Google, Bing, Brave, Wikipedia, …) behind one JSON API. When the operator
 * runs (or points at) an instance, this gives the strongest privacy and backend
 * control of any slot, with clean structured JSON instead of HTML parsing.
 * @module @deepseek-ai/dsh-web-search-aggregator/engines/searxng
 */

import type { WebSearchSource } from '@deepseek-ai/dsh-web'
import { EngineError } from '../engine.ts'
import type { EngineSearchInput, SearchEngineAdapter } from '../engine.ts'
import { isHttpUrl } from '../html.ts'
import { fetchBody, httpError } from '../http.ts'

interface SearxngResult {
  url?: string
  title?: string
  content?: string
  publishedDate?: string
}

interface SearxngResponse {
  results?: SearxngResult[]
}

function parseResults(json: SearxngResponse): WebSearchSource[] {
  const sources: WebSearchSource[] = []
  for (const item of json.results ?? []) {
    const url = item.url
    if (url === undefined || !isHttpUrl(url)) continue
    sources.push({
      url,
      ...item.title !== undefined && item.title.length > 0 ? { title: item.title } : {},
      ...item.content !== undefined && item.content.length > 0 ? { snippet: item.content } : {},
      ...item.publishedDate !== undefined && item.publishedDate.length > 0 ? { publishedAt: item.publishedDate } : {},
    })
  }
  return sources
}

/** SearXNG JSON-API engine adapter, active only when a reachable instance base is configured. */
export class SearXngEngine implements SearchEngineAdapter {
  readonly id = 'searxng'
  readonly label = 'SearXNG'

  constructor(private readonly baseURL: string) {}

  available(): boolean {
    try {
      return new URL(this.baseURL).protocol === 'https:' || new URL(this.baseURL).protocol === 'http:'
    } catch {
      return false
    }
  }

  async search(input: EngineSearchInput): Promise<WebSearchSource[]> {
    const base = this.baseURL.replace(/\/+$/, '')
    const url = `${base}/search?q=${encodeURIComponent(input.query)}&format=json`
    const body = await fetchBody(url, input.signal)
    if (!body.ok) throw httpError(this.label, body.status)
    let json: SearxngResponse
    try {
      json = JSON.parse(body.text) as SearxngResponse
    } catch {
      throw new EngineError('parse', `${this.label} returned non-JSON output (instance disables format=json?)`)
    }
    return parseResults(json)
  }
}
