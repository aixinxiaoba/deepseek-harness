/**
 * DuckDuckGo keyless engine: the `html.duckduckgo.com/html` endpoint. Broad
 * coverage (its index aggregates Bing, Wikipedia, and DDG's own) with no API key
 * and no per-vendor 403-on-key-mismatch. HTML is brittle, so a parse miss
 * degrades to zero results and the aggregator falls back.
 * @module @deepseek-ai/dsh-web-search-aggregator/engines/duckduckgo
 */

import type { WebSearchSource } from '@deepseek-ai/dsh-web'
import { EngineError } from '../engine.ts'
import type { EngineSearchInput, SearchEngineAdapter } from '../engine.ts'
import { cleanText, isHttpUrl, unwrapDdgRedirect } from '../html.ts'
import { fetchBody, httpError } from '../http.ts'

const ENDPOINT = 'https://html.duckduckgo.com/html/'

const RESULT_LINK = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g
const RESULT_SNIPPET = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>(.*?)<\/a>/g

function parseResults(text: string): WebSearchSource[] {
  const links: Array<{ url: string; title: string }> = []
  let match: RegExpExecArray | null
  while ((match = RESULT_LINK.exec(text)) !== null) {
    const url = unwrapDdgRedirect(decodeUrl(match[1] as string))
    if (!isHttpUrl(url)) continue
    const title = cleanText(match[2] as string)
    if (title.length === 0) continue
    links.push({ url, title })
  }
  const snippets: string[] = []
  while ((match = RESULT_SNIPPET.exec(text)) !== null) {
    snippets.push(cleanText(match[1] as string))
  }
  return links.map((link, index) => ({
    url: link.url,
    title: link.title,
    ...snippets[index] !== undefined && snippets[index].length > 0 ? { snippet: snippets[index] } : {},
  }))
}

/** DuckDuckGo redirect-wrapped hrefs use URL-encoding on the outer query. */
function decodeUrl(href: string): string {
  return href
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/** DuckDuckGo keyless engine adapter. */
export class DuckDuckGoEngine implements SearchEngineAdapter {
  readonly id = 'duckduckgo'
  readonly label = 'DuckDuckGo'
  available(): boolean {
    return true
  }
  async search(input: EngineSearchInput): Promise<WebSearchSource[]> {
    const url = `${ENDPOINT}?q=${encodeURIComponent(input.query)}`
    const body = await fetchBody(url, input.signal)
    if (!body.ok) throw httpError(this.label, body.status)
    if (body.text.length === 0) throw new EngineError('empty', `${this.label} returned an empty page`)
    return parseResults(body.text)
  }
}
