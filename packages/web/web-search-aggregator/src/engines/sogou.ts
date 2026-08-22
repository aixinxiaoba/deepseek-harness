/**
 * Sogou engine (China-first). Sogou is a third mainland-reachable Chinese index
 * (after Baidu and cn.bing) and — unlike Baidu — returns real absolute target
 * URLs instead of opaque redirects, which `web_fetch` can open directly. HTML
 * parsing, defensive like the others.
 * @module @deepseek-ai/dsh-web-search-aggregator/engines/sogou
 */

import type { WebSearchSource } from '@deepseek-ai/dsh-web'
import { EngineError } from '../engine.ts'
import type { EngineSearchInput, SearchEngineAdapter } from '../engine.ts'
import { cleanText, isHttpUrl } from '../html.ts'
import { fetchBody, httpError } from '../http.ts'

const ENDPOINT = 'https://www.sogou.com/web'

const TITLE_LINK = /<h3[^>]*class="[^"]*vr-title[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g

/** Sogou's snippet containers, tried in order within a window after each title. */
const SNIPPET_CONTAINERS: RegExp[] = [
  /<div[^>]*class="[^"]*text-layout[^"]*"[^>]*>([\s\S]*?)<\/div>/,
  /<div[^>]*class="[^"]*space-txt[^"]*"[^>]*>([\s\S]*?)<\/div>/,
]

function parseResults(text: string): WebSearchSource[] {
  const sources: WebSearchSource[] = []
  let match: RegExpExecArray | null
  while ((match = TITLE_LINK.exec(text)) !== null) {
    const url = decodeAmp(match[1] as string)
    if (!isHttpUrl(url)) continue
    const title = cleanText(match[2] as string)
    if (title.length === 0) continue
    const tail = text.slice(TITLE_LINK.lastIndex, TITLE_LINK.lastIndex + 2500)
    let snippet: string | undefined
    for (const container of SNIPPET_CONTAINERS) {
      const found = container.exec(tail)
      if (found !== null) {
        snippet = cleanText(found[1] as string).slice(0, 300)
        break
      }
    }
    sources.push({
      url,
      title,
      ...snippet !== undefined && snippet.length > 0 ? { snippet } : {},
    })
  }
  return sources
}

function decodeAmp(href: string): string {
  return href.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

/** Sogou keyless engine adapter. */
export class SogouEngine implements SearchEngineAdapter {
  readonly id = 'sogou'
  readonly label = 'Sogou'
  available(): boolean {
    return true
  }
  async search(input: EngineSearchInput): Promise<WebSearchSource[]> {
    const url = `${ENDPOINT}?query=${encodeURIComponent(input.query)}`
    const body = await fetchBody(url, input.signal)
    if (!body.ok) throw httpError(this.label, body.status)
    if (body.text.length === 0) throw new EngineError('empty', `${this.label} returned an empty page`)
    return parseResults(body.text)
  }
}
