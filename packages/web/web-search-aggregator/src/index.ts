/**
 * `@deepseek-ai/dsh-web-search-aggregator`: registers a vendor-independent,
 * multi-engine `WebSearchProvider` with `ctx.web`. A function/namespace plugin
 * (NOT a default-export service): it registers INTO the seam's provider registry
 * exactly as the DeepSeek/Exa providers do; the key is owned by `@deepseek-ai/dsh-web`.
 *
 * Engines are tried in configured order with transparent failover. Keyless
 * engines (DuckDuckGo, Mojeek, a self-hosted SearXNG) work with zero keys; the
 * commercial rows (Brave, Bing, Tavily) activate automatically the moment their
 * API key is present and are transparently skipped otherwise.
 * @module @deepseek-ai/dsh-web-search-aggregator
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { AggregateSearchProvider } from './aggregate.ts'
import type { SearchEngineAdapter } from './engine.ts'
import { DuckDuckGoEngine } from './engines/duckduckgo.ts'
import { MojeekEngine } from './engines/mojeek.ts'
import { BaiduEngine } from './engines/baidu.ts'
import { CnBingEngine } from './engines/cnbing.ts'
import { SogouEngine } from './engines/sogou.ts'
import { SearXngEngine } from './engines/searxng.ts'
import { BraveEngine } from './engines/brave.ts'
import { BingEngine } from './engines/bing.ts'
import { TavilyEngine } from './engines/tavily.ts'
import type { KeyGetter } from './engines/types.ts'

export { AggregateSearchProvider } from './aggregate.ts'
export { EngineError } from './engine.ts'
export type { EngineFailureReason, EngineSearchInput, SearchEngineAdapter } from './engine.ts'
export {
  DuckDuckGoEngine,
  MojeekEngine,
  BaiduEngine,
  CnBingEngine,
  SogouEngine,
  SearXngEngine,
  BraveEngine,
  BingEngine,
  TavilyEngine,
} from './engines/index.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-aggregator'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Default stable id the provider registers under. */
export const DEFAULT_PROVIDER_ID = 'web-search-aggregator'

/** Known engine ids the plugin can build a `SearchEngineAdapter` for. */
export type EngineName = 'baidu' | 'cnbing' | 'sogou' | 'duckduckgo' | 'mojeek' | 'searxng' | 'brave' | 'bing' | 'tavily'

/** One position in the ordered fallback chain. */
export interface EngineEntry {
  /** Which engine adapter to build; the position in `engines[]` is the fallback order. */
  engine: EngineName
  /** Endpoint base for `searxng` (`{baseURL}/search?format=json`); ignored by others. */
  baseURL?: string
  /** Credential reference (environment-variable name) for a commercial engine. */
  apiKeyEnv?: string
  /** Remove this engine from the chain when false. Defaults to true. */
  enabled?: boolean
}

/** Plugin config. Empty engines leave the provider unavailable (an honest config condition). */
export interface Config {
  /** Seam id this provider registers under. Defaults to `web-search-aggregator`. */
  providerId?: string
  /** Ordered fallback chain; the first live engine to yield results wins. */
  engines?: EngineEntry[]
}

const engineName = z.union(['baidu', 'cnbing', 'sogou', 'duckduckgo', 'mojeek', 'searxng', 'brave', 'bing', 'tavily'] as const)

const engineEntry: z<EngineEntry> = z.object({
  engine: engineName,
  baseURL: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
  enabled: z.boolean().default(true),
})

export const Config: z<Config> = z.object({
  providerId: z.string(),
  // China-first default: Baidu, cn.bing, and Sogou are reachable on the mainland,
  // where DuckDuckGo/Mojeek/Bing-global are blocked; the international engines
  // remain as last-resort fallbacks (useful behind a proxy or outside China).
  engines: z.array(engineEntry).default([
    { engine: 'baidu' },
    { engine: 'cnbing' },
    { engine: 'sogou' },
    { engine: 'mojeek' },
    { engine: 'duckduckgo' },
  ]),
})

/** Settings namespace carrying this provider's engine chain. */
export const WEB_SEARCH_AGGREGATOR_SETTINGS_NAMESPACE = settingsNamespace('web-search-aggregator')

/** Build the live key getter for one commercial engine from the environment plane. */
function keyOf(ctx: Context, env: string): KeyGetter {
  return () => launchEnvironmentOf(ctx).get(env)?.value
}

/**
 * Build the ordered adapter chain from the currently authoritative config.
 * Commercial engines are constructed regardless of key presence; their
 * `available()` decides at search time whether they take part (a Missing key
 * transparently drops them). A `searxng` entry without a baseURL is skipped.
 */
function buildEngines(ctx: Context, config: Config): SearchEngineAdapter[] {
  const adapters: SearchEngineAdapter[] = []
  for (const entry of config.engines ?? []) {
    if (entry.enabled === false) continue
    switch (entry.engine) {
      case 'baidu': adapters.push(new BaiduEngine()); break
      case 'cnbing': adapters.push(new CnBingEngine()); break
      case 'sogou': adapters.push(new SogouEngine()); break
      case 'duckduckgo': adapters.push(new DuckDuckGoEngine()); break
      case 'mojeek': adapters.push(new MojeekEngine()); break
      case 'searxng':
        if (entry.baseURL !== undefined && entry.baseURL.length > 0) adapters.push(new SearXngEngine(entry.baseURL))
        break
      case 'brave': adapters.push(new BraveEngine(keyOf(ctx, entry.apiKeyEnv ?? 'BRAVE_API_KEY'))); break
      case 'bing': adapters.push(new BingEngine(keyOf(ctx, entry.apiKeyEnv ?? 'BING_SEARCH_API_KEY'))); break
      case 'tavily': adapters.push(new TavilyEngine(keyOf(ctx, entry.apiKeyEnv ?? 'TAVILY_API_KEY'))); break
    }
  }
  return adapters
}

/** Register the aggregator search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_AGGREGATOR_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source
    },
    // The registration carries no resolved value: the provider resolves the
    // engine chain per search, so a committed change needs no re-registration.
    onChange: () => {},
  })
  ctx.web.registerSearchProvider(
    new AggregateSearchProvider(() => buildEngines(ctx, current()), config.providerId ?? DEFAULT_PROVIDER_ID),
  )
}
