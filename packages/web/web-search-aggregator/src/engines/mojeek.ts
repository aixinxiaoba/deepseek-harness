/**
 * Mojeek keyless engine. A genuinely independent index (not Google/Bing-derived),
 * no API key, privacy-friendly, and notably bot-tolerant — the independence and
 * robustness leg of the keyless tier. HTML parsing, defensive like DuckDuckGo's.
 * @module @deepseek-ai/dsh-web-search-aggregator/engines/mojeek
 */

import type { WebSearchSource } from '@deepseek-ai/dsh-web'
import { EngineError } from '../engine.ts'
import type { EngineSearchInput, SearchEngineAdapter } from '../engine.ts'
import { cleanText, isHttpUrl } from '../html.ts'
import { fetchBody, httpError } from '../http.ts'

const ENDPOINT = 'https://www.mojeek.com/search'

const RESULT_LINK = /<a[^>]+class="[^"]*ob[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g
const RESULT_SNIPPET = /<p class="s">(.*?)<\/p>/g

function parseResults(text: string): WebSearchSource[] {
  const links: Array<{ url: string; title: string }> = []
  let match: RegExpExecArray | null
  while ((match = RESULT_LINK.exec(text)) !== null) {
    const url = decodeAmp(match[1] as string)
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

function decodeAmp(href: string): string {
  return href.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

/** Mojeek keyless engine adapter. */
export class MojeekEngine implements SearchEngineAdapter {
  readonly id = 'mojeek'
  readonly label = 'Mojeek'
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
