/**
 * Baidu engine (China-first). Baidu is the dominant Chinese-language search
 * engine and is reachable on the mainland where DuckDuckGo/Mojeek/Bing are
 * blocked, so it leads the default chain for Chinese networks. HTML parsing,
 * defensive like the other keyless engines.
 * @module @deepseek-ai/dsh-web-search-aggregator/engines/baidu
 */

import type { WebSearchSource } from '@deepseek-ai/dsh-web'
import { EngineError } from '../engine.ts'
import type { EngineSearchInput, SearchEngineAdapter } from '../engine.ts'
import { cleanText, isHttpUrl } from '../html.ts'
import { fetchBody, httpError } from '../http.ts'

const ENDPOINT = 'https://www.baidu.com/s'
const ORIGIN = 'https://www.baidu.com'

const TITLE_LINK = /<h3[^>]*class="[^"]*c-title[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g

/**
 * Baidu's snippet container class is unstable across result types and versions.
 * Try the known containers in order, each scoped to a bounded window after the
 * title, so a markup drift degrades to fewer snippets — never to a crash.
 */
const SNIPPET_CONTAINERS: RegExp[] = [
  /<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/,
  /<span[^>]*class="[^"]*content-right[^"]*"[^>]*>([\s\S]*?)<\/span>/,
  /<span[^>]*class="[^"]*content-left[^"]*"[^>]*>([\s\S]*?)<\/span>/,
]

/** Baidu wraps real targets in `/link?url=…`; absolutize relative/opaque hrefs. */
function absolutize(href: string): string {
  if (href.startsWith('//')) return `https:${href}`
  if (href.startsWith('/')) return `${ORIGIN}${href}`
  return href
}

function parseResults(text: string): WebSearchSource[] {
  const sources: WebSearchSource[] = []
  let match: RegExpExecArray | null
  while ((match = TITLE_LINK.exec(text)) !== null) {
    const url = absolutize(decodeAmp(match[1] as string))
    if (!isHttpUrl(url)) continue
    const title = cleanText(match[2] as string)
    if (title.length === 0) continue
    const tail = text.slice(TITLE_LINK.lastIndex, TITLE_LINK.lastIndex + 3000)
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

/** Baidu keyless engine adapter. */
export class BaiduEngine implements SearchEngineAdapter {
  readonly id = 'baidu'
  readonly label = 'Baidu'
  available(): boolean {
    return true
  }
  async search(input: EngineSearchInput): Promise<WebSearchSource[]> {
    const url = `${ENDPOINT}?wd=${encodeURIComponent(input.query)}`
    const body = await fetchBody(url, input.signal)
    if (!body.ok) throw httpError(this.label, body.status)
    if (body.text.length === 0) throw new EngineError('empty', `${this.label} returned an empty page`)
    return parseResults(body.text)
  }
}
