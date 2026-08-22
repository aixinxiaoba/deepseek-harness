/**
 * Tavily engine (commercial row). Tavily aggregates Google and Bing specifically
 * for AI-agent retrieval, and is the default search tool of popular agent
 * frameworks — the drop-in "LLM search" choice. POST JSON API; active only when a
 * key is present.
 * @module @deepseek-ai/dsh-web-search-aggregator/engines/tavily
 */

import type { WebSearchSource } from '@deepseek-ai/dsh-web'
import { EngineError } from '../engine.ts'
import type { EngineSearchInput, SearchEngineAdapter } from '../engine.ts'
import type { KeyGetter } from './types.ts'
import { USER_AGENT } from '../http.ts'

const ENDPOINT = 'https://api.tavily.com/search'

interface TavilyItem {
  url?: string
  title?: string
  content?: string
}

interface TavilyResponse {
  results?: TavilyItem[]
}

function parseResults(json: TavilyResponse): WebSearchSource[] {
  const sources: WebSearchSource[] = []
  for (const item of json.results ?? []) {
    if (item.url === undefined || item.url.length === 0) continue
    sources.push({
      url: item.url,
      ...item.title !== undefined && item.title.length > 0 ? { title: item.title } : {},
      ...item.content !== undefined && item.content.length > 0 ? { snippet: item.content } : {},
    })
  }
  return sources
}

/** Tavily engine adapter, active when `TAVILY_API_KEY` is present. */
export class TavilyEngine implements SearchEngineAdapter {
  readonly id = 'tavily'
  readonly label = 'Tavily'

  constructor(private readonly key: KeyGetter) {}

  available(): boolean {
    return (this.key()?.length ?? 0) > 0
  }

  async search(input: EngineSearchInput): Promise<WebSearchSource[]> {
    const apiKey = this.key()
    if (apiKey === undefined || apiKey.length === 0) {
      throw new EngineError('http', `${this.label} engine is unavailable without an API key`)
    }
    let response: Response
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        ...input.signal !== undefined ? { signal: input.signal } : {},
        headers: { 'content-type': 'application/json', 'accept': 'application/json', 'user-agent': USER_AGENT },
        body: JSON.stringify({ api_key: apiKey, query: input.query, max_results: input.maxResults ?? 10, search_depth: 'basic' }),
      })
    } catch (error: unknown) {
      if (input.signal?.aborted === true) throw error
      throw new EngineError('http', `network failure: ${String(error)}`)
    }
    const text = await response.text()
    if (!response.ok) {
      if (response.status === 429) throw new EngineError('limit', 'Tavily rate-limited', response.status)
      throw new EngineError('http', `Tavily responded HTTP ${response.status}`, response.status)
    }
    let json: TavilyResponse
    try {
      json = JSON.parse(text) as TavilyResponse
    } catch {
      throw new EngineError('parse', 'Tavily returned non-JSON output')
    }
    return parseResults(json)
  }
}
