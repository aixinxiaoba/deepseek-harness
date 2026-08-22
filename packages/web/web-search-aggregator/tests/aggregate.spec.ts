import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import type { WebError } from '@deepseek-ai/dsh-web'
import * as aggregatorPlugin from '../src/index.ts'
import { AggregateSearchProvider } from '../src/index.ts'
import type { SearchEngineAdapter } from '../src/index.ts'
import { DuckDuckGoEngine, MojeekEngine, BaiduEngine, CnBingEngine, SogouEngine, SearXngEngine, BraveEngine, BingEngine, TavilyEngine } from '../src/index.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { 'content-type': 'text/html' } })
}

const ddgHtml = `
  <div class="result results_links results_links_deep web-result">
    <a rel="nofollow" class="result__a" href="https://a.example/post">A Title</a>
    <a class="result__snippet">a snippet</a>
  </div>
  <a class="result__a" href="https://b.example">B&nbsp;Title</a>
`

const mojeekHtml = `
  <ul class="results-standard">
    <li class="result">
      <h2><a class="ob" href="https://m.example/one" title="One">One</a></h2>
      <p class="s">first snippet</p>
    </li>
    <li class="result">
      <h2><a class="ob" href="https://m.example/two">Two</a></h2>
      <p class="s">second snippet</p>
    </li>
  </ul>
`

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('engine adapters', () => {
  it('Baidu parses c-title results, absolutizes /link?url= redirects, and attaches c-abstract snippets', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(
      '<h3 class="c-title c-title-b"><a href="/link?url=abc123"><em>张雪机车</em>官网</a></h3>'
      + '<div class="c-abstract c-abstract-baike">这是第一条摘要</div>',
    )))
    const sources = await new BaiduEngine().search({ query: 'q' })
    const [url] = vi.mocked(fetch).mock.calls[0] as unknown as [string]
    expect(url).toContain('www.baidu.com/s?wd=q')
    expect(sources).toEqual([
      { url: 'https://www.baidu.com/link?url=abc123', title: '张雪机车官网', snippet: '这是第一条摘要' },
    ])
  })

  it('Baidu attaches snippets from the content-right span container too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(
      '<h3 class="c-title"><a href="https://www.baidu.com/link?url=x">标题</a></h3>'
      + '<div class="c-span-last"><span class="content-right_2U8vV">content-right 摘要文字</span></div>',
    )))
    const sources = await new BaiduEngine().search({ query: 'q' })
    expect(sources).toEqual([
      { url: 'https://www.baidu.com/link?url=x', title: '标题', snippet: 'content-right 摘要文字' },
    ])
  })

  it('Baidu omits the snippet when no known container follows the title', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(
      '<h3 class="c-title"><a href="https://www.baidu.com/link?url=y">纯标题</a></h3><div class="c-showurl">baidu.com</div>',
    )))
    const sources = await new BaiduEngine().search({ query: 'q' })
    expect(sources).toEqual([{ url: 'https://www.baidu.com/link?url=y', title: '纯标题' }])
  })

  it('Baidu throws a blocked EngineError on HTTP 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse('<html>verify</html>', 403)))
    const error = await new BaiduEngine().search({ query: 'q' }).catch((e: unknown) => e) as WebError
    expect(error).toMatchObject({ name: 'EngineError', reason: 'blocked' })
  })

  it('Sogou parses vr-title results (with <em> highlights stripped) and text-layout snippets', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(
      '<h3 class="vr-title "><a class="" target="_blank" href="https://news.qq.com/share-video?vid=1"><em>张雪机车</em>运抵台湾</a></h3>'
      + '<div class="text-layout">这是搜狗摘要文字</div>',
    )))
    const sources = await new SogouEngine().search({ query: 'q' })
    const [url] = vi.mocked(fetch).mock.calls[0] as unknown as [string]
    expect(url).toContain('www.sogou.com/web?query=q')
    expect(sources).toEqual([
      { url: 'https://news.qq.com/share-video?vid=1', title: '张雪机车运抵台湾', snippet: '这是搜狗摘要文字' },
    ])
  })

  it('Sogou keeps the real absolute URL (no redirect unwrap needed)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(
      '<h3 class="vr-title"><a href="https://mp.weixin.qq.com/s/x">微信文章</a></h3><div class="text-layout">摘要</div>',
    )))
    const sources = await new SogouEngine().search({ query: 'q' })
    expect(sources[0]?.url).toBe('https://mp.weixin.qq.com/s/x')
  })

  it('cn.bing parses b_algo result blocks with titles and snippets', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(
      '<ol id="b_results"><li class="b_algo"><h2><a href="https://example.cn/zhangxue">张雪机车 百科</a></h2>'
      + '<div class="b_caption"><p>一段摘要内容</p></div></li>'
      + '<li class="b_algo"><h2><a href="https://news.example.cn/x">新闻</a></h2><div class="b_caption"></div></li></ol>',
    )))
    const sources = await new CnBingEngine().search({ query: 'q' })
    const [url] = vi.mocked(fetch).mock.calls[0] as unknown as [string]
    expect(url).toContain('cn.bing.com/search?q=q')
    expect(sources).toEqual([
      { url: 'https://example.cn/zhangxue', title: '张雪机车 百科', snippet: '一段摘要内容' },
      { url: 'https://news.example.cn/x', title: '新闻' },
    ])
  })

  it('DuckDuckGo parses result links and snippets, decoding entities', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(ddgHtml)))
    const sources = await new DuckDuckGoEngine().search({ query: 'q' })
    const [url, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('html.duckduckgo.com/html/?q=q')
    expect((init.headers as Record<string, string>)['user-agent']).toContain('Mozilla')
    expect(sources).toEqual([
      { url: 'https://a.example/post', title: 'A Title', snippet: 'a snippet' },
      { url: 'https://b.example', title: 'B Title' },
    ])
  })

  it('DuckDuckGo unwraps /l/?uddg= redirect hrefs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example%2Fx">X</a>',
    )))
    const sources = await new DuckDuckGoEngine().search({ query: 'q' })
    expect(sources[0]?.url).toBe('https://real.example/x')
  })

  it('DuckDuckGo throws HTTP 403 as a blocked EngineError (not a UI retryable failure)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse('<html>challenge</html>', 403)))
    const error = await new DuckDuckGoEngine().search({ query: 'q' }).catch((e: unknown) => e) as WebError
    expect(error).toMatchObject({ name: 'EngineError', reason: 'blocked' })
  })

  it('Mojeek parses result blocks and snippets', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(mojeekHtml)))
    const sources = await new MojeekEngine().search({ query: 'q' })
    const [url] = vi.mocked(fetch).mock.calls[0] as unknown as [string]
    expect(url).toContain('www.mojeek.com/search?q=q')
    expect(sources).toEqual([
      { url: 'https://m.example/one', title: 'One', snippet: 'first snippet' },
      { url: 'https://m.example/two', title: 'Two', snippet: 'second snippet' },
    ])
  })

  it('SearXNG parses JSON results incl. publishedDate', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      results: [{ url: 'https://s.example/a', title: 'A', content: 'ctx', publishedDate: '2026-01-02' }],
    })))
    const engine = new SearXngEngine('https://searx.example/')
    expect(engine.available()).toBe(true)
    expect(engine.search({ query: 'q' })).resolves.toEqual([
      { url: 'https://s.example/a', title: 'A', snippet: 'ctx', publishedAt: '2026-01-02' },
    ])
  })

  it('SearXNG is unavailable without a baseURL', async () => {
    expect(new SearXngEngine('').available()).toBe(false)
  })

  it('SearXNG reports an unprocessable non-JSON body as a parse EngineError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse('<html>not json</html>')))
    const error = await new SearXngEngine('https://searx.example').search({ query: 'q' }).catch((e: unknown) => e) as WebError
    expect(error).toMatchObject({ name: 'EngineError', reason: 'parse' })
  })

  it('commercial engines are available only when their key is present, and parse JSON', async () => {
    expect(new BraveEngine(() => undefined).available()).toBe(false)
    expect(new BraveEngine(() => 'k').available()).toBe(true)
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ web: { results: [{ url: 'https://b.example', title: 'B', description: 'd' }] } })))
    await expect(new BraveEngine(() => 'k').search({ query: 'q' })).resolves.toEqual([{ url: 'https://b.example', title: 'B', snippet: 'd' }])

    expect(new BingEngine(() => 'k').available()).toBe(true)
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ webPages: { value: [{ url: 'https://m.example', name: 'M', snippet: 's' }] } })))
    await expect(new BingEngine(() => 'k').search({ query: 'q' })).resolves.toEqual([{ url: 'https://m.example', title: 'M', snippet: 's' }])

    expect(new TavilyEngine(() => 'k').available()).toBe(true)
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [{ url: 'https://t.example', title: 'T', content: 'c' }] })))
    await expect(new TavilyEngine(() => 'k').search({ query: 'q' })).resolves.toEqual([{ url: 'https://t.example', title: 'T', snippet: 'c' }])
  })

  it('Tavily posts an OpenAI-style search body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [] })))
    await new TavilyEngine(() => 'k').search({ query: 'hello', maxResults: 5 })
    const [, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toMatchObject({ api_key: 'k', query: 'hello', max_results: 5 })
  })
})

/** A chain helper for aggregator tests: build engines from stubbed fetch responses in order. */
function provider(engines: SearchEngineAdapter[]): AggregateSearchProvider {
  return new AggregateSearchProvider(() => engines)
}

describe('AggregateSearchProvider failover', () => {
  it('uses the first engine that yields results', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(ddgHtml)))
    const result = await provider([new DuckDuckGoEngine(), new MojeekEngine()]).search({ query: 'q' })
    expect(result.sources).toEqual([{ url: 'https://a.example/post', title: 'A Title', snippet: 'a snippet' }, { url: 'https://b.example', title: 'B Title' }])
  })

  it('falls back to the next engine when the first fails (HTTP 403)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(htmlResponse('<html>blocked</html>', 403))
      .mockResolvedValueOnce(htmlResponse(mojeekHtml))
    vi.stubGlobal('fetch', fetchMock)
    const result = await provider([new DuckDuckGoEngine(), new MojeekEngine()]).search({ query: 'q' })
    expect(result.sources).toEqual([
      { url: 'https://m.example/one', title: 'One', snippet: 'first snippet' },
      { url: 'https://m.example/two', title: 'Two', snippet: 'second snippet' },
    ])
    expect(fetchMock.mock.calls.length).toBe(2)
  })

  it('throws WEB_PROVIDER_ERROR naming every engine when all fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse('<html>blocked</html>', 403)))
    const error = await provider([new MojeekEngine(), new MojeekEngine()]).search({ query: 'q' }).catch((e: unknown) => e) as WebError
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('Mojeek')
    expect(error.message).toContain('blocked')
  })

  it('is unavailable when no engine is available', async () => {
    const error = await provider([new BraveEngine(() => undefined)]).search({ query: 'q' }).catch((e: unknown) => e) as WebError
    expect(error.code).toBe('WEB_PROVIDER_UNAVAILABLE')
  })

  it('dedupes by URL and caps to maxResults, setting truncated', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(ddgHtml)))
    const result = await provider([new DuckDuckGoEngine()]).search({ query: 'q', maxResults: 1 })
    expect(result.sources).toEqual([{ url: 'https://a.example/post', title: 'A Title', snippet: 'a snippet' }])
    expect(result.truncated).toBe(true)
  })

  it('surfaces cancellation as WEB_ABORTED rather than falling back', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })))
    const search = provider([new DuckDuckGoEngine(), new MojeekEngine()]).search({ query: 'q' }, controller.signal)
    controller.abort(new Error('stop'))
    await expect(search).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })
})

describe('web-search-aggregator plugin registration', () => {
  it('registers into ctx.web and searches through the engine chain', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(ddgHtml)))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: 'web-search-aggregator' })
    const fiber = await ctx.plugin(aggregatorPlugin, { engines: [{ engine: 'duckduckgo' }] })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: expect.any(Array) })
    await fiber.dispose()
  })

  it('is a namespace plugin with no default export and inject web', () => {
    expect('default' in aggregatorPlugin).toBe(false)
    expect(aggregatorPlugin.inject).toEqual(['web'])
    expect(typeof aggregatorPlugin.apply).toBe('function')
  })
})
