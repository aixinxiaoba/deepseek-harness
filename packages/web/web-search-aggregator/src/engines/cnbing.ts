/**
 * Microsoft Bing China engine (China-first). `cn.bing.com` is reachable on the
 * mainland (unlike the global `bing.com`), giving broad coverage when Baidu
 * results are thin. HTML `b_algo` parsing, defensive like the others.
 * @module @deepseek-ai/dsh-web-search-aggregator/engines/cnbing
 */

import type { WebSearchSource } from '@deepseek-ai/dsh-web'
import { EngineError } from '../engine.ts'
import type { EngineSearchInput, SearchEngineAdapter } from '../engine.ts'
import { cleanText, isHttpUrl } from '../html.ts'
import { fetchBody, httpError } from '../http.ts'

const ENDPOINT = 'https://cn.bing.com/search'

const RESULT_BLOCK = /class="b_algo"[\s\S]*?<\/li>/g
const BLOCK_TITLE = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/i
const BLOCK_SNIPPET = /<p[^>]*>(.*?)<\/p>/i

function parseResults(text: string): WebSearchSource[] {
  const sources: WebSearchSource[] = []
  let block: RegExpExecArray | null
  while ((block = RESULT_BLOCK.exec(text)) !== null) {
    const title = BLOCK_TITLE.exec(block[0])
    if (title === null) continue
    const url = decodeAmp(title[1] as string)
    if (!isHttpUrl(url)) continue
    const titleText = cleanText(title[2] as string)
    if (titleText.length === 0) continue
    const snippet = BLOCK_SNIPPET.exec(block[0])?.[1]
    sources.push({
      url,
      title: titleText,
      ...snippet !== undefined && cleanText(snippet).length > 0 ? { snippet: cleanText(snippet) } : {},
    })
  }
  return sources
}

function decodeAmp(href: string): string {
  return href.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

/** cn.bing.com keyless engine adapter. */
export class CnBingEngine implements SearchEngineAdapter {
  readonly id = 'cnbing'
  readonly label = 'Bing 中国'
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
