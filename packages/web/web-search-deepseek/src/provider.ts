/**
 * DeepSeek search through an Anthropic-compatible Messages model call with the native
 * `web_search_20250305` server tool. Each search costs a model turn, but returns structured
 * result blocks; absence of those blocks is an error rather than a prose-scraping fallback.
 * The wire format and native `fetch` client are provider-private and do not use `ctx.llm`.
 * @module @deepseek-ai/dsh-web-search-deepseek/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-session'
import type {
  AnthropicError,
  AnthropicResponse,
  ContentBlock,
  OpenAiError,
  OpenAiResponse,
  TextBlock,
  WebSearchToolResultBlock,
} from './types.ts'

/** Stable id this provider registers under. */
export const DEEPSEEK_PROVIDER_ID = 'deepseek-official'

/**
 * Default endpoint: DeepSeek's Anthropic-compatible API, `/v1` included
 * (`/messages` is appended). This is NOT the chat-completions base
 * (`https://api.deepseek.com`) `@deepseek-ai/dsh-llm-deepseek` uses, so this
 * provider does NOT reuse `$DEEPSEEK_BASE_URL` — only the API key is shared.
 */
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1'

/** Default Anthropic-format model name (aligned with the repo's DeepSeek model vocabulary). */
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash'

/** Default `anthropic-version` header value. */
export const DEEPSEEK_DEFAULT_API_VERSION = '2023-06-01'

/** Default upper bound on generated tokens for the Messages request. */
export const DEEPSEEK_DEFAULT_MAX_TOKENS = 4096

/** Default maximum `web_search` server-tool uses per request. */
export const DEEPSEEK_DEFAULT_MAX_USES = 5

/** Wire protocol a search backend answers with. */
export type SearchProtocol = 'anthropic' | 'openai'

/** Default wire protocol: Anthropic-compatible Messages (DeepSeek official). */
export const DEEPSEEK_DEFAULT_PROTOCOL: SearchProtocol = 'anthropic'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Anthropic Messages request body ({@link DeepSeekSearchLlmRequest.body}). */
export interface DeepSeekSearchAnthropicBody {
  readonly model: string
  readonly max_tokens: number
  readonly messages: readonly [{
    readonly role: 'user'
    readonly content: readonly [{
      readonly type: 'text'
      readonly text: string
    }]
  }]
  readonly tools: readonly [{
    readonly type: 'web_search_20250305'
    readonly name: 'web_search'
    readonly max_uses: number
  }]
}

/** OpenAI `/chat/completions` request body ({@link DeepSeekSearchLlmRequest.body}). */
export interface DeepSeekSearchOpenAiBody {
  readonly model: string
  readonly max_tokens: number
  readonly messages: readonly [{
    readonly role: 'user'
    readonly content: string
  }]
}

/**
 * Exact secret-free search request recorded immediately before one auxiliary
 * search dispatch. `body` is the provider's either protocol dialect.
 */
export interface DeepSeekSearchLlmRequest {
  /** Fully resolved search endpoint. */
  readonly endpoint: string
  /** `anthropic-version` header value. */
  readonly apiVersion: string
  /** Exact JSON body sent to the provider. */
  readonly body: DeepSeekSearchAnthropicBody | DeepSeekSearchOpenAiBody
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Secret-free auxiliary DeepSeek search request recorded before dispatch. */
    'web/deepseek-search-llm-request': DeepSeekSearchLlmRequest
  }
}

/** Resolved provider options (the plugin's `apply` supplies credential and constant defaults). */
export interface DeepSeekSearchProviderOptions {
  /** Literal DeepSeek API key; when present it wins over {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current DeepSeek API key for one search operation. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Endpoint base; `/messages` is appended. */
  baseURL: string
  /** Anthropic-format model name. */
  model: string
  /** `anthropic-version` header value. */
  apiVersion: string
  /** Upper bound on generated tokens for the request. */
  maxTokens: number
  /** Maximum `web_search` server-tool uses per request. */
  maxUses: number
  /** Wire protocol the resolved endpoint answers with. */
  protocol: SearchProtocol
  /**
   * Whether to extract citeable URLs from the model's prose when an
   * OpenAI-style backend returns no structured search fields. Defaults to
   * false (strict): a prose-only answer that yields no sources is an error.
   */
  allowProseFallback: boolean
  /**
   * Record the exact secret-free request immediately before dispatch. A throw
   * prevents dispatch so model-visible auxiliary input cannot escape logging.
   */
  recordRequest?: (request: DeepSeekSearchLlmRequest) => void
}

/**
 * Build a `url → cited_text` map from every `text` block's `citations[]`. This
 * is the snippet source: Anthropic `web_search_result` items carry
 * `url`/`title`/`page_age` but typically NO inline snippet — the excerpt lives
 * in a separate `text` block's citation, keyed by `url` (first occurrence wins).
 *
 * @param blocks - the response's content blocks; non-`text` blocks are skipped.
 * @returns the `url → cited_text` map (empty when no citations are present).
 */
export function citationSnippets(blocks: readonly ContentBlock[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const block of blocks) {
    if (block.type !== 'text') continue
    for (const cite of (block as TextBlock).citations ?? []) {
      if (cite.url != null && cite.url.length > 0 && cite.cited_text != null && cite.cited_text.length > 0 && !map.has(cite.url)) {
        map.set(cite.url, cite.cited_text)
      }
    }
  }
  return map
}

/**
 * Map a DeepSeek Anthropic Messages response to a normalized search result. Walks
 * `web_search_tool_result` blocks for citeable `web_search_result` items, joins each to its
 * citation excerpt as `snippet`, and dedupes by `url` (a `max_uses > 1` request can surface
 * the same URL across searches). The web service owns the final `maxResults` truncation, so
 * `truncated` is always `false` here.
 *
 * @param response - the parsed Messages response body.
 * @returns the normalized result with deduped, snippet-joined sources.
 * @throws {@link WebError} when native search produced no result block.
 */
export function mapAnthropicResponse(response: AnthropicResponse): WebSearchResult {
  const blocks = response.content ?? []
  const resultBlocks = blocks.filter(
    (block): block is WebSearchToolResultBlock => block.type === 'web_search_tool_result',
  )
  if (resultBlocks.length === 0) {
    throw new WebError(
      'DeepSeek returned no web_search_tool_result blocks; the request may not have triggered native web search',
      'WEB_PROVIDER_ERROR',
    )
  }

  const snippets = citationSnippets(blocks)
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      if (item.type !== 'web_search_result' || item.url.length === 0 || seen.has(item.url)) continue
      seen.add(item.url)
      const snippet = snippets.get(item.url)
      sources.push({
        url: item.url,
        ...item.title != null && item.title.length > 0 ? { title: item.title } : {},
        ...snippet != null && snippet.length > 0 ? { snippet } : {},
        ...item.page_age != null && item.page_age.length > 0 ? { publishedAt: item.page_age } : {},
      })
    }
  }
  return { sources, truncated: false }
}

/**
 * Map an OpenAI-compatible `/chat/completions` response to a normalized search
 * result. Structured `message.citations` map directly; when none are present a
 * prose fallback (only when {@link DeepSeekSearchProviderOptions.allowProseFallback})
 * extracts `[label](url)` markdown links and bare URLs from the model's answer.
 * Sources dedupe by URL (markdown-labelled wins for its title). The model's
 * answer text becomes the result's `content`. Strict mode throws when no source
 * can be parsed.
 *
 * @param response - the parsed `/chat/completions` body.
 * @param allowProseFallback - whether to extract URLs from the model's prose.
 * @returns the normalized result with deduped sources and the answer text.
 * @throws {@link WebError} when no source was parsed.
 */
export function mapOpenAIResponse(response: OpenAiResponse, allowProseFallback: boolean): WebSearchResult {
  const message = response.choices?.[0]?.message
  const prose = message?.content ?? ''
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []

  const push = (url: string, title?: string): void => {
    if (url.length === 0 || seen.has(url)) return
    seen.add(url)
    sources.push({ url, ...title !== undefined && title.length > 0 ? { title } : {} })
  }

  for (const citation of message?.citations ?? []) {
    push(citation.url ?? '', citation.title ?? undefined)
  }

  if (sources.length === 0 && allowProseFallback && prose.length > 0) {
    // `[label](url)` markdown links first (they carry a display title).
    for (const match of prose.matchAll(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/gu)) {
      push(match[2] as string, match[1])
    }
    // Bare URLs not already captured by a markdown link.
    const bare = prose.match(/https?:\/\/[^\s<>"')]+/gu) ?? []
    for (const url of bare) {
      if (!seen.has(url)) push(url)
    }
  }

  if (sources.length === 0) {
    throw new WebError(
      'DeepSeek search returned no parseable source URLs; the request may not have triggered a web search',
      'WEB_PROVIDER_ERROR',
    )
  }

  return {
    ...prose.trim().length > 0 ? { content: prose } : {},
    sources,
    truncated: false,
  }
}

/** The DeepSeek-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class DeepSeekSearchProvider implements WebSearchProvider {
  readonly id = DEEPSEEK_PROVIDER_ID

  /**
   * @param resolveOptions - resolves the options for ONE operation from the
   *   request, snapshotted once at the operation's entry so one search never
   *   mixes two sections or backends. A thunk rather than a value because the
   *   plugin's settings section can change between searches, and re-registering
   *   the provider to carry a new endpoint would make the seam's selection
   *   observable to the user as a flicker. The request lets the resolver pick
   *   the backend (explicit `backend`, agent-default-model auto-match, or the
   *   legacy single endpoint).
   */
  constructor(private readonly resolveOptions: (request: WebSearchRequest) => DeepSeekSearchProviderOptions) {}

  available(): boolean {
    // Backend-resolution errors (e.g. several providers share the selected
    // model) deliberately propagate rather than flattening to "unavailable", so
    // the misconfiguration stays loud instead of reading as a missing provider.
    const options = this.resolveOptions({ query: '' })
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
      && URL.canParse(options.baseURL)
      && isPositiveInteger(options.maxTokens)
      && isPositiveInteger(options.maxUses)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // One snapshot for the whole operation: credential resolution awaits, and a
    // settings write landing inside that await must not send the key resolved
    // from the old section to the endpoint named by the new one.
    const options = this.resolveOptions(request)
    const apiKey = await this.apiKey(options, signal)
    if (options.protocol === 'openai') {
      return this.searchOpenAI(options, apiKey, request, signal)
    }
    throwIfSearchAborted(signal)
    const endpoint = `${options.baseURL}/messages`
    const body: DeepSeekSearchLlmRequest['body'] = {
      model: options.model,
      max_tokens: options.maxTokens,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: `Perform a web search for the query: ${request.query}` }],
      }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: options.maxUses }],
    }
    options.recordRequest?.({
      endpoint,
      apiVersion: options.apiVersion,
      body,
    })
    throwIfSearchAborted(signal)
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          // Official DeepSeek expects `x-api-key`; an Anthropic-compatible proxy
          // may expect `Authorization: Bearer` — send both so either resolves.
          'x-api-key': apiKey,
          'authorization': `Bearer ${apiKey}`,
          'anthropic-version': options.apiVersion,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw new WebError(`DeepSeek search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `DeepSeek API error (HTTP ${status})`
      try {
        const parsed = await response.json() as AnthropicError
        const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      // Authentication rejection is a CONFIGURATION class of failure, not a
      // transient provider error: the resolved credential does not open THIS
      // endpoint. The common shape (pinned by a live incident): chat works
      // because a settings `llm-deepseek:` section reroutes it to another
      // platform whose key then lives in DEEPSEEK_API_KEY, while this provider
      // still sends it to api.deepseek.com. Say so instead of letting the model
      // retry a request no retry can fix.
      throw classifyHttpError(status, message, endpoint, options.apiKeyEnv)
    }

    try {
      const payload = await response.json() as AnthropicResponse
      return mapAnthropicResponse(payload)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      if (error instanceof WebError) throw error
      throw new WebError(`DeepSeek returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  /**
   * Run one search through an OpenAI-compatible `/chat/completions` backend.
   * The model's answer prose becomes `content`; citeable URLs come from
   * structured `message.citations` or, when the backend allows prose fallback,
   * markdown-link/bare-URL extraction.
   * @param options - the snapshotted backend options.
   * @param apiKey - the resolved credential for this operation.
   * @param request - the caller's search request.
   * @param signal - cancellation signal forwarded to the fetch.
   * @returns the normalized search result.
   */
  private async searchOpenAI(
    options: DeepSeekSearchProviderOptions,
    apiKey: string,
    request: WebSearchRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchResult> {
    const endpoint = `${options.baseURL.replace(/\/+$/, '')}/chat/completions`
    const body: DeepSeekSearchOpenAiBody = {
      model: options.model,
      max_tokens: options.maxTokens,
      messages: [{ role: 'user', content: `Perform a web search for the query: ${request.query}` }],
    }
    options.recordRequest?.({ endpoint, apiVersion: options.apiVersion, body })
    throwIfSearchAborted(signal)
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'x-api-key': apiKey,
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw new WebError(`DeepSeek search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `DeepSeek API error (HTTP ${status})`
      try {
        const parsed = await response.json() as OpenAiError
        const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      }
      throw classifyHttpError(status, message, endpoint, options.apiKeyEnv)
    }

    try {
      const payload = await response.json() as OpenAiResponse
      return mapOpenAIResponse(payload, options.allowProseFallback)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      if (error instanceof WebError) throw error
      throw new WebError(`DeepSeek returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  /**
   * Resolve one operation's credential without retaining it on the provider.
   * @param options - the caller's snapshot, so the key and the endpoint it is sent to come from one section.
   * @param signal - abort signal for the surrounding search.
   * @returns the resolved key.
   */
  private async apiKey(options: DeepSeekSearchProviderOptions, signal?: AbortSignal): Promise<string> {
    throwIfSearchAborted(signal)
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    let resolved: string | undefined
    try {
      resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(undefined), signal)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw new WebError(
        `DeepSeek search credential resolution failed: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
    if (resolved !== undefined && resolved.length > 0) return resolved
    const ref = options.apiKeyEnv ?? 'DEEPSEEK_API_KEY'
    throw new WebError(
      `DeepSeek search has no API key for "${ref}"; store it through the credentials service`
      + ' (the web Models page writes it), export it in the launching environment, or set a literal'
      + ' "apiKey" in the web-search-deepseek config',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

/**
 * Race a same-process asynchronous preflight against caller cancellation. The
 * attached settlement handlers keep observing an uncooperative operation after
 * abort so a later rejection cannot become unhandled.
 */
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(searchAborted(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(searchAborted(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(new Error(String(error).replace(/^Error: /u, ''), { cause: error }))
      },
    )
  })
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfSearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw searchAborted(signal)
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('DeepSeek search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * Classify a failing HTTP search response. 401/403 are a CONFIGURATION class of
 * failure (the resolved credential does not open THIS endpoint); the common shape
 * is chat rerouted to another platform whose key then lives in `DEEPSEEK_API_KEY`
 * while this provider still sends it to `api.deepseek.com`. Say so instead of
 * letting the model retry a request no retry can fix.
 * @param status - the HTTP status.
 * @param message - the provider's message detail (or the status line).
 * @param endpoint - the endpoint that rejected the request, for the guidance.
 * @param apiKeyEnv - the resolved credential reference name.
 * @returns the WebError for the failure.
 */
function classifyHttpError(
  status: number,
  message: string,
  endpoint: string,
  apiKeyEnv: CredentialRef | undefined,
): WebError {
  if (status === 401 || status === 403) {
    const ref = apiKeyEnv ?? 'DEEPSEEK_API_KEY'
    return new WebError(
      `${message} — the "${ref}" credential was rejected by ${endpoint} (HTTP ${status}). `
      + 'When chat\'s llm-deepseek baseURL is overridden to another platform, the shared key belongs to THAT platform, '
      + 'not api.deepseek.com: set web-search-deepseek\'s own baseURL and apiKey for the platform that issued the key, '
      + 'store a DeepSeek-platform key, or mount a different search provider.',
      'WEB_PROVIDER_AUTH_FAILED',
    )
  }
  return new WebError(message, 'WEB_PROVIDER_ERROR')
}

/** True for DeepSeek request limits that can be sent to the Messages API. */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}
