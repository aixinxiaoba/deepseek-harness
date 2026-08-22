/**
 * Microsoft Bing Web Search API engine (commercial row). Bing is one of the two
 * classic enterprise search APIs; chosen for coverage and stable JSON. Active
 * only when an API key is present.
 * @module @deepseek-ai/dsh-web-search-aggregator/engines/bing
 */

import type { WebSearchSource } from '@deepseek-ai/dsh-web'
import { EngineError } from '../engine.ts'
import type { EngineSearchInput, SearchEngineAdapter } from '../engine.ts'
import type { KeyGetter } from './types.ts'
import { fetchBody, httpError } from '../http.ts'

const ENDPOINT = 'https://api.bing.microsoft.com/v7.0/search'

interface BingPage {
  url?: string
  name?: string
  snippet?: string
}

interface BingResponse {
  webPages?: { value?: BingPage[] }
}

function parseResults(json: BingResponse): WebSearchSource[] {
  const sources: WebSearchSource[] = []
  for (const page of json.webPages?.value ?? []) {
    if (page.url === undefined || page.url.length === 0) continue
    sources.push({
      url: page.url,
      ...page.name !== undefined && page.name.length > 0 ? { title: page.name } : {},
      ...page.snippet !== undefined && page.snippet.length > 0 ? { snippet: page.snippet } : {},
    })
  }
  return sources
}

/** Bing Web Search API engine adapter, active when a Bing API key is present. */
export class BingEngine implements SearchEngineAdapter {
  readonly id = 'bing'
  readonly label = 'Bing'

  constructor(private readonly key: KeyGetter) {}

  available(): boolean {
    return (this.key()?.length ?? 0) > 0
  }

  async search(input: EngineSearchInput): Promise<WebSearchSource[]> {
    const apiKey = this.key()
    if (apiKey === undefined || apiKey.length === 0) {
      throw new EngineError('http', `${this.label} engine is unavailable without an API key`)
    }
    const url = `${ENDPOINT}?q=${encodeURIComponent(input.query)}`
    const body = await fetchBody(url, input.signal, {
      'Ocp-Apim-Subscription-Key': apiKey,
      'accept': 'application/json',
    })
    if (!body.ok) throw httpError(this.label, body.status)
    let json: BingResponse
    try {
      json = JSON.parse(body.text) as BingResponse
    } catch {
      throw new EngineError('parse', `${this.label} returned non-JSON output`)
    }
    return parseResults(json)
  }
}
