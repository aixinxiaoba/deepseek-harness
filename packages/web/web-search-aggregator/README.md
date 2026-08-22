# @deepseek-ai/dsh-web-search-aggregator

English | [中文](README.zh.md)

A **vendor-independent, multi-engine** `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It runs a configured chain of search engines in order and fails over transparently, so no single backend's 403, rate-limit, outage, or key mismatch fails a search the way a single-vendor provider would.

This is an **implementation** package like `dsh-web-search-deepseek` / `dsh-web-search-exa`: it registers a provider into `ctx.web` (name `web-search-aggregator` by default), owns no model-facing tool, and does not depend on `ctx.llm`. The model's `web_search`/`web_fetch` tools come from [`dsh-tool-web`](../tool-web/README.md).

## Why it exists

The DeepSeek chat adapter was being rerouted to a Volcano Ark gateway whose OpenAI-compatible `/chat/completions` model does **not** perform genuine web search (it declines, or fabricates search-engine query links). A good search capability must not be hostage to one vendor's key or a gateway that only pretends to search. This aggregator gives the harness its **own** search: keyless engines that work with no account, plus optional commercial/SearXNG rows.

## Engine tiers (the layered design)

| Tier | Engines | Key | When it matters |
|---|---|---|---|
| **Keyless base** (default) | `baidu`, `cnbing`, `sogou`, `mojeek`, `duckduckgo` | none | Works out of the box, no accounts. China-first: Baidu + cn.bing + Sogou lead so mainland networks get results where the international engines are blocked; DuckDuckGo/Mojeek remain last-resort (behind a proxy or outside China) |
| **Self-hosted aggregator** | `searxng` (your instance) | none | Strongest privacy; aggregates Google/Bing/Brave/Wikipedia behind one JSON API |
| **Commercial API** | `brave`, `bing`, `tavily` | required | IP-independent reliability + SLA; the industry benchmark |

The engine **adapter interface** is the load-bearing design: each tier is the same `SearchEngineAdapter`, so you turn on reliability with one config row (a key or a SearXNG base URL), never a re-architecture.

## How the chain works

Engines are tried in configured order; the first live engine to yield non-empty sources wins. If an engine fails (HTTP error, block, rate limit, parse miss, or zero results) the aggregator moves to the next. Only when **every** engine fails does it throw `WEB_PROVIDER_ERROR` (or `WEB_PROVIDER_UNAVAILABLE` if none is even configured) naming each engine's failure mode — so the model sees *why* search failed rather than retrying a doomed request. Results dedupe by URL (first wins), respect the seam's `maxResults` (setting `truncated`), and honor cancellation as `WEB_ABORTED`.

A clean-but-empty engine is a fallback signal, not a hard error; an already-aborted call never falls back across a genuine abort.

## Config

```yaml
- id: web-search-aggregator
  name: '@deepseek-ai/dsh-web-search-aggregator'
  config:
    engines:
      - engine: baidu
      - engine: cnbing
      - engine: sogou
      - engine: mojeek
      - engine: duckduckgo
      - engine: searxng
        baseURL: https://your-searxng.example
      - engine: brave
        apiKeyEnv: BRAVE_API_KEY
      - engine: bing
        apiKeyEnv: BING_SEARCH_API_KEY
      - engine: tavily
        apiKeyEnv: TAVILY_API_KEY
```

| Key | Default | Meaning |
|---|---|---|
| `providerId` | `web-search-aggregator` | Seam id this provider registers under. |
| `engines` | `[{baidu},{cnbing},{sogou},{mojeek},{duckduckgo}]` | Ordered fallback chain. Each entry: `engine` (one of the nine), `baseURL` (searxng), `apiKeyEnv` (commercial credential reference), `enabled` (drop from the chain when false). |

Commercial engines are constructed regardless of key presence; their `available()` decides at search time whether they take part — a missing key transparently drops them. A `searxng` entry without a `baseURL` is skipped. The section is a Settings section, so a user layer over the base projection re-routes the **next** search without re-registration.

To flip the desktop back to structured DeepSeek results, set `ctx.web`'s `searchProvider` back to `deepseek-official` and store a DeepSeek-platform key.

## Request path

A search issues one sequential request per live engine until one succeeds: `GET {endpoint}?q=…` for the HTML engines, `GET {searxng}/search?q=…&format=json`, and the respective commercial JSON APIs (Brave `X-Subscription-Token`, Bing `Ocp-Apim-Subscription-Key`, Tavily POST `api_key`). A browser-ish `User-Agent` is sent. Providers failures become `WEB_PROVIDER_ERROR`; total non-configuration surfaces the per-engine reasons.

## Known Limitations and Deferred Work

- **China network reality** — on the mainland, DuckDuckGo, Mojeek, and global Bing are blocked; Baidu, cn.bing, and Sogou are the reliable keyless trio and lead the default chain. Outside China (or behind a proxy) the international engines take over via the same chain.
- **Keyless engines bot-block datacenter/proxied IPs** — DuckDuckGo and Mojeek can return 403 / network-fail for non-residential IPs; they are a genuine self-hosted/at-home tier, not an SLA. For reliable production search from any IP, add a `searxng` base URL or a commercial API key.
- **HTML parsing is brittle** — Baidu/DuckDuckGo/Mojeek/cn.bing/Sogou extraction is regex-based and defensive; a changed markup degrades to fewer results (and the aggregator falls back), never a crash.
- **No result-count knob on keyless engines** — `maxResults` is enforced by the aggregator post-hoc (`truncated`).
- **Sequential, not parallel, engine fan-out** — prefers gentleness over latency so live engines are not all hammered by one query.