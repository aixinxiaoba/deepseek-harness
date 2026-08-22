/**
 * Register a DeepSeek-backed provider in `ctx.web`. It calls the Anthropic-compatible Messages API
 * with native `web_search_20250305`. The provider reuses `DEEPSEEK_API_KEY` but not
 * `DEEPSEEK_BASE_URL`, because search and chat-completions use different bases.
 * @module @deepseek-ai/dsh-web-search-deepseek
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-session'
import type { WebSearchRequest } from '@deepseek-ai/dsh-web'
import {
  DeepSeekSearchProvider,
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
} from './provider.ts'
import type { DeepSeekSearchProviderOptions } from './provider.ts'
import { DEEPSEEK_DEFAULT_PROTOCOL } from './provider.ts'
import type { SearchProtocol } from './provider.ts'

export {
  DeepSeekSearchProvider,
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_DEFAULT_PROTOCOL,
  DEEPSEEK_PROVIDER_ID,
  mapOpenAIResponse,
} from './provider.ts'
export type {
  DeepSeekSearchAnthropicBody,
  DeepSeekSearchLlmRequest,
  DeepSeekSearchOpenAiBody,
  DeepSeekSearchProviderOptions,
  SearchProtocol,
} from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-deepseek'

/** The web seam this provider registers into. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** Wire-protocol matcher for a named OpenAI-style search backend (`providers`). */
export interface OpenAiBackendConfig {
  /** Endpoint base for `POST {baseURL}/chat/completions`. Required. */
  baseURL: string
  /** Credential reference resolved per search; defaults to `DEEPSEEK_API_KEY`. */
  apiKeyEnv?: string
  /**
   * Model id used both as the request model AND as the auto-match key against
   * `ctx.agentDefaultModel`'s model. Distinct backends must not share one.
   */
  model?: string
  /** Extract citeable URLs from the model's prose when no structured citations. */
  allowProseFallback?: boolean
}

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Literal DeepSeek API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string
  /** Credential reference resolved for each search; defaults to `DEEPSEEK_API_KEY`. */
  apiKeyEnv?: string
  /** Anthropic-compatible endpoint base; `/messages` is appended. */
  baseURL?: string
  /** Anthropic-format model name. Defaults to `deepseek-v4-flash`. */
  model?: string
  /** `anthropic-version` header value. Defaults to `2023-06-01`. */
  apiVersion?: string
  /** Upper bound on generated tokens for the Messages request. Defaults to 4096. */
  maxTokens?: number
  /** Maximum `web_search` server-tool uses per request. Defaults to 5. */
  maxUses?: number
  /** Wire protocol for the single-endpoint legacy config. `openai` requires {@link baseURL}. */
  protocol?: SearchProtocol
  /**
   * Extract citeable URLs from the model's prose when an OpenAI-style backend
   * returns no structured search fields (legacy single-endpoint path). Named
   * backends set their own; defaults to false (strict).
   */
  allowProseFallback?: boolean
  /**
   * Named OpenAI-style backends the provider routes a search to: an explicit
   * `request.backend`, else auto-match against `ctx.agentDefaultModel`'s model,
   * else the legacy single endpoint.
   */
  providers?: Record<string, OpenAiBackendConfig>
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  // Declared here rather than only at the use site: a configuration surface
  // renders the resolved section, so a default the schema does not carry reads
  // there as no value at all.
  baseURL: z.string(),
  model: z.string().default(DEEPSEEK_DEFAULT_MODEL),
  apiVersion: z.string().default(DEEPSEEK_DEFAULT_API_VERSION),
  maxTokens: z.number().step(1).min(1).default(DEEPSEEK_DEFAULT_MAX_TOKENS),
  maxUses: z.number().step(1).min(1).default(DEEPSEEK_DEFAULT_MAX_USES),
  protocol: z.union(['anthropic', 'openai'] as const).default(DEEPSEEK_DEFAULT_PROTOCOL),
  allowProseFallback: z.boolean().default(false),
  providers: z.dict(z.object({
    baseURL: z.string(),
    apiKeyEnv: z.string().role('credential-ref'),
    model: z.string(),
    allowProseFallback: z.boolean().default(true),
  })).default({}),
})

/**
 * Environment variable naming this provider's endpoint. Deliberately distinct
 * from `$DEEPSEEK_BASE_URL`, which belongs to the chat-completions adapter:
 * search speaks the Anthropic-compatible Messages API, so one variable cannot
 * serve both.
 */
const SEARCH_BASE_URL_ENV = 'DEEPSEEK_SEARCH_BASE_URL'

/** Settings namespace carrying this provider's endpoint, model, and key reference. */
export const WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE = settingsNamespace('web-search-deepseek')

/**
 * A resolved search backend: the resolved protocol, endpoint, credential
 * reference, model, and prose-fallback policy for ONE search operation.
 */
interface ResolvedBackend {
  protocol: SearchProtocol
  baseURL: string
  apiKeyEnv: string
  model: string
  allowProseFallback: boolean
}

/** Read the legacy single-endpoint backend (with env/default fallbacks). */
function legacyBackend(ctx: Context, config: Config): ResolvedBackend {
  const protocol: SearchProtocol = config.protocol ?? DEEPSEEK_DEFAULT_PROTOCOL
  const baseURL = config.baseURL
    ?? launchEnvironmentOf(ctx).get(SEARCH_BASE_URL_ENV)?.value
    ?? (protocol === 'anthropic' ? DEEPSEEK_DEFAULT_BASE_URL : '')
  return {
    protocol,
    baseURL,
    apiKeyEnv: config.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    model: config.model ?? DEEPSEEK_DEFAULT_MODEL,
    allowProseFallback: config.allowProseFallback ?? false,
  }
}

/** Read the current agent's selected model, when the service is mounted. */
function currentAgentModel(ctx: Context): string | undefined {
  const source = ctx.get('agentDefaultModel') as { currentSelection?: () => { model?: string } } | undefined
  return source?.currentSelection?.().model
}

/** Project a named `providers` entry into a resolved OpenAI backend. */
function namedBackend(named: OpenAiBackendConfig): ResolvedBackend {
  return {
    protocol: 'openai',
    baseURL: named.baseURL,
    apiKeyEnv: named.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    model: named.model ?? DEEPSEEK_DEFAULT_MODEL,
    allowProseFallback: named.allowProseFallback ?? true,
  }
}

/**
 * Resolve ONE operation's backend from the current section and request.
 * Priority: an explicit `request.backend` naming a configured provider, then
 * auto-match the current agent's selected model against a provider's `model`,
 * then the legacy single endpoint. Auto-match throws on ambiguity so a model
 * shared by several providers is a loud config error, not a silent route.
 */
function resolveBackend(ctx: Context, config: Config, request: WebSearchRequest): ResolvedBackend {
  const registry = config.providers ?? {}
  // 1. Explicit backend.
  if (request.backend !== undefined) {
    const named = registry[request.backend]
    if (named !== undefined) return namedBackend(named)
    throw new Error(
      `web-search-deepseek: request backend "${request.backend}" is not configured;`
      + ` known providers: ${Object.keys(registry).join(', ') || '(none)'}`,
    )
  }
  // 2. Auto-match the current agent's selected model.
  const model = currentAgentModel(ctx)
  if (model !== undefined && Object.keys(registry).length > 0) {
    const matching = Object.keys(registry).filter(key => registry[key]?.model === model)
    if (matching.length === 1) return namedBackend(registry[matching[0] as string] as OpenAiBackendConfig)
    if (matching.length > 1) {
      throw new Error(
        `web-search-deepseek: ${matching.length} providers advertise model "${model}" (${matching.join(', ')});`
        + ' set distinct provider models or pass an explicit backend',
      )
    }
  }
  // 3. Legacy single endpoint.
  return legacyBackend(ctx, config)
}

/**
 * Project the resolved section + backend into the options the provider serves
 * this search with. Environment fallbacks stay here rather than in the provider:
 * every value it reads is already fully defaulted.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @param request - the caller's search request (backend routing).
 * @returns options for one search.
 */
function resolveOptions(ctx: Context, config: Config, request: WebSearchRequest): DeepSeekSearchProviderOptions {
  const backend = resolveBackend(ctx, config, request)
  const apiKeyEnv = credentialRef(backend.apiKeyEnv)
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0
    ? config.apiKey
    : undefined
  return {
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      // Without the seam the environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
    baseURL: backend.baseURL,
    model: backend.model,
    apiVersion: config.apiVersion ?? DEEPSEEK_DEFAULT_API_VERSION,
    maxTokens: config.maxTokens ?? DEEPSEEK_DEFAULT_MAX_TOKENS,
    maxUses: config.maxUses ?? DEEPSEEK_DEFAULT_MAX_USES,
    protocol: backend.protocol,
    allowProseFallback: backend.allowProseFallback,
    recordRequest: (request) => {
      ctx.get('agents')?.currentInitiator()?.session.append(
        'web/deepseek-search-llm-request',
        request,
      )
    },
  }
}

/** Register the DeepSeek search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source
    },
    // The registration carries no resolved value: the provider projects the
    // section per search, so a committed change needs no re-registration.
    onChange: () => {},
  })
  ctx.web.registerSearchProvider(
    new DeepSeekSearchProvider(request => resolveOptions(ctx, current(), request)),
  )
}
