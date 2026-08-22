# @deepseek-ai/dsh-web-search-aggregator

[English](README.md) | 中文

为 harness [web 能力 seam](../web/README.zh.md)（`ctx.web`）提供的**厂商无关、多引擎** `WebSearchProvider`。它按配置顺序跑一串搜索后端，并在失败时**透明回退**——因此任何单一后端的 403、限流、宕机或密钥错配，都不会像单厂商 provider 那样让一次搜索直接失败。

与 `dsh-web-search-deepseek` / `dsh-web-search-exa` 一样是**实现**包：它向 `ctx.web` 注册一个 provider（默认名为 `web-search-aggregator`），不拥有面向模型的工具，也不依赖 `ctx.llm`。模型的 `web_search`/`web_fetch` 工具来自 [`dsh-tool-web`](../tool-web/README.zh.md)。

## 为什么需要它

此前 DeepSeek 聊天适配器被改道到火山方舟（Ark）网关，其 OpenAI 兼容 `/chat/completions` 模型并不真的联网检索（它要么拒绝，要么编造搜索引擎查询链接）。好的搜索能力不能被困在某一家厂商的 key、或一个只假装能搜的网关手里。这个聚合器给了 harness **自己的**搜索：免密钥引擎无需任何账户即可用，另有可选的商用 / SearXNG 档位。

## 引擎档位（分层设计）

| 档位 | 引擎 | 密钥 | 何时重要 |
|---|---|---|---|
| **免密钥基座**（默认） | `baidu`、`cnbing`、`sogou`、`mojeek`、`duckduckgo` | 无 | 开箱即用、无需账户。**中国优先**：百度 + 必应中国 + 搜狗打头，国内网络也有结果（海外引擎在国内被墙）；DuckDuckGo/Mojeek 留作末位兜底（代理或境外时可用） |
| **自托管聚合器** | `searxng`（你自己的实例） | 无 | 隐私最强；在单一 JSON API 后聚合 google/bing/brave/wikipedia |
| **商用 API** | `brave`、`bing`、`tavily` | 需要 | 与 IP 无关的可靠性与 SLA——行业基准 |

**引擎适配器接口**才是承重设计：每一档都是同一个 `SearchEngineAdapter`，所以要用可靠性只需加一行配置（一个 key 或一个 SearXNG 基址），无需改架构。

## 链式回退如何工作

按配置顺序尝试引擎，**首个产出非空来源的存活引擎胜出**。若某引擎失败（HTTP 错误、被封锁、限流、解析失败、或零结果），聚合器切到下一个。**只有全部引擎都失败**才抛 `WEB_PROVIDER_ERROR`（若一个都没配置则是 `WEB_PROVIDER_UNAVAILABLE`），并点名每个引擎的失败形态——让模型看到**为什么**失败，而不是重试一个注定失败的请求。结果按 URL 去重（首个赢）、遵守 seam 的 `maxResults`（置 `truncated`）、以 `WEB_ABORTED` 处理取消。

干净但为空的引擎是回退信号而非硬错误；已中止的调用绝不会跨真实中止去回退。

## 配置

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

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `providerId` | `web-search-aggregator` | 本 provider 注册的 seam id。 |
| `engines` | `[{baidu},{cnbing},{sogou},{mojeek},{duckduckgo}]` | 有序回退链。每项：`engine`（九个之一）、`baseURL`（searxng）、`apiKeyEnv`（商用凭据引用）、`enabled`（为 false 时从链中剔除）。 |

商用引擎无论有无 key 都会构造，由各自 `available()` 在搜索时决定是否参与——缺 key 透明跳过。缺少 `baseURL` 的 `searxng` 条目被跳过。本段即 Settings 段，叠加在 base 投影上的用户层会作用于**下一次**搜索，无需重新注册。

要把桌面搜索切回结构化 DeepSeek 结果，把 `ctx.web` 的 `searchProvider` 改回 `deepseek-official` 并存入 DeepSeek 平台 key 即可。

## 请求路径

一次搜索按顺序对每个存活引擎发一次请求，直到某次成功：HTML 引擎用 `GET {endpoint}?q=…`，`searxng` 用 `GET {base}/search?q=…&format=json`，商用 API 各自 JSON（Brave `X-Subscription-Token`、Bing `Ocp-Apim-Subscription-Key`、Tavily POST `api_key`）。会发送浏览器风格 `User-Agent`。provider 失败变为 `WEB_PROVIDER_ERROR`；总失败并列每个引擎的具体原因。

## 已知限制与暂缓事项

- **国内网络现实**——在境内，DuckDuckGo、Mojeek、必应国际版被墙；百度、必应中国、搜狗是可靠的免密钥组合，并排在默认链最前。境外（或挂代理）时，同一链条自动切换到海外引擎。
- **免密钥引擎会封禁数据中心/代理 IP**——DuckDuckGo 与 Mojeek 对非住宅 IP 可能返回 403/网络失败；它们属真正的自托管/家用档，而非 SLA。要从任意 IP 稳定支持生产搜索，请加 `searxng` 基址或商用 API key。
- **HTML 解析脆弱**——百度/DuckDuckGo/Mojeek/cn.bing/搜狗 的提取基于防御式正则；标记变化只会退化为更少结果（聚合器照常回退），绝不崩溃。
- **免密钥引擎没有结果数量旋钮**——`maxResults` 由聚合器事后执行（`truncated`）。
- **顺序而非并行扇出**——偏向温和而非低延迟，避免一次查询同时狂打所有存活引擎。