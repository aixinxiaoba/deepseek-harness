# 方案：`web-search-deepseek` 多后端 + 按前端模型自动匹配（OpenAI 方言）

**状态**：用户已确认方案；本文档为实施蓝本。

**背景**：桌面端聊天被 `settings.yaml` 的 `llm-deepseek.baseURL` 改到火山方舟（Ark，OpenAI `/chat/completions` 协议）后，搜索仍由 `web-search-deepseek` 固定打 `https://api.deepseek.com/anthropic/v1`（Anthropic `{baseURL}/messages` + `web_search_20250305`），而现有 `DEEPSEEK_API_KEY`（末4位 `0dcc`）是 Ark key，打真 DeepSeek 端点恒定 401。

**探查结论（已实测）**：
- Ark 网关只讲 OpenAI 协议，`POST /api/coding/v3/messages`（Anthropic）全 404，无兼容入口。
- Ark `POST /api/coding/v3/chat/completions`（模型 `deepseek-v4-flash`）**真能搜索**，且回答带真实 URL 的 markdown 链接（如 `[张雪机车](https://www.zhangxuejiche.com)`），可挤出结构化 `WebSearchSource`。
- `web-search-deepseek` 是纯 Anthropic 实现，故需加 OpenAI 方言才能接 Ark/智谱/qwen 等 OpenAI 兼容网关。

**目标**：改造 `web-search-deepseek`，使其：
1. 可指向任意 OpenAI 兼容 `/chat/completions` 网关（Ark / 智谱 / 阿里 qwen 等）。
2. **不需要静态 `searchProvider` 每模型切换**——搜索后端按前端当前选中的模型自动匹配。
3. 保留 Anthropic 路径与"不从文本抓取"的默认严格姿态。

---

## 一、设计

### 1. 配置（`web-search-deepseek` 插件，沿用 `llm-pi-ai.providers` 字典模式）

```yaml
web-search-deepseek:
  protocol: openai                 # 默认方言；anthropic 时保持现状路径
  providers:                       # 具名 OpenAI 后端注册表；model 是自动匹配键
    ark:
      baseURL: https://ark.cn-beijing.volces.com/api/coding/v3
      apiKeyEnv: DEEPSEEK_API_KEY
      model: deepseek-v4-flash
      allowProseFallback: true
    zhipu:
      baseURL: https://open.bigmodel.cn/api/coding/paas/v4
      apiKeyEnv: ZAI_CODING_CN_API_KEY
      model: glm-5.3
      allowProseFallback: true
    qwen:
      baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
      apiKeyEnv: DASHSCOPE_API_KEY
      model: qwen-plus
      allowProseFallback: true
```

- 保留既有单端点字段（`baseURL`/`apiKeyEnv`/`model`/`allowProseFallback`）作向后兼容默认（anthropic 现状）。
- 注册表内**不同后端 model 不得重复**（否则按 model 自动匹配歧义；歧义时须显式 `backend`）。

### 2. 后端解析优先级（每次搜索时，`provider.ts`）

1. **显式 `backend`**：`web_search` 工具可选参数 / `WebSearchRequest.backend` 点名注册表项 → 用之。
2. **按前端模型自动匹配**：`ctx.agentDefaultModel.currentSelection().model` 与某后端 `model` 相等，且唯一 → 用之。**这是方案的核心，免除任何静态默认切换。**
3. **回退**：legacy 单端点配置（anthropic / 未配注册表时行为）。

`searchProvider` 仍指向单一 `deepseek-official`（base `cordis.patch.yml` 已如此），前端每次换模型即自动换搜索后端。

### 3. OpenAI 方言执行

- 请求 `POST {backend.baseURL}/chat/completions`，`Authorization: Bearer` + `x-api-key` 双头（代理兼容）。
- 解析 `choices[0].message`：
  - **结构化优先**：若含 `citations`/search 字段 → 直接映射。
  - **prose 兜底**：仅当 `allowProseFallback: true`，正则抽 `[label](url)` markdown 链接 + 裸 URL → `WebSearchSource{url, title?, snippet?}`，按 URL 去重。
  - 抽不到 URL → `WEB_PROVIDER_ERROR`（与"无结果块"一致）。
- Anthropic 路径（`/messages` + `web_search_20250305` + 结构化映射）与默认严格姿态**保持完全不变**。

### 4. 接口改动

- `packages/web/web/src/types.ts`：`WebSearchRequest` 增**可选** `readonly backend?: string`（稳定路由名，勿泄露 OpenAI 细节；其它 provider 可忽略）。seam 原样透传 request。
- `packages/web/web-search-deepseek`：`Config` + schema 增 `protocol` 与 `providers`；`DeepSeekSearchProvider.search()` 按上述优先级解析后端；`apply` 注入可选的 `agentDefaultModel`（经 `ctx.get('agentDefaultModel')`，惰性、可缺失即回退）。
- `packages/web/tool-web/src/search.ts`：`web_search` schema 增**可选** `backend` 字符串参数 → 透传到 `WebSearchRequest.backend`。

---

## 二、改动文件

| 文件 | 改动 |
|---|---|
| `packages/web/web/src/types.ts` | `WebSearchRequest` 增可选 `backend?: string` |
| `packages/web/web-search-deepseek/src/index.ts` | Config/schema：`protocol`、`providers`；apply 透传 auto-match；`resolveOptions` 接触 `ctx.get('agentDefaultModel')` |
| `packages/web/web-search-deepseek/src/provider.ts` | 后端解析优先级、OpenAI 方言执行（chat/completions）、结构化+prose-兜底解码、export 常量 |
| `packages/web/tool-web/src/search.ts` | `web_search` 可选 `backend` 参数 → request |
| `packages/web/web-search-deepseek/tests/*` | 注册表解析、自动匹配、backend 覆盖、openai URL 提取、anthropic 回归 |
| `packages/web/web-search-deepseek/README*.md` / `.i18n.yaml` | 文档 `protocol`/`providers`/`backend`/自动匹配 |
| `docs/config-catalog.md` / `.zh.md` | 重生成 |

---

## 三、测试

- 注册表解析（命名后端 → 正确 baseURL/apiKeyEnv/model）。
- 自动匹配（`agentDefaultModel.currentSelection().model` → 唯一后端；无匹配/多匹配歧义处理）。
- `backend` 覆盖优先级 > 自动匹配 > legacy。
- openai URL 提取：markdown 链接、裸 URL、按 URL 去重、无 URL → `WEB_PROVIDER_ERROR`。
- anthropic 路径回归（`/messages` + `web_search_20250305`）。

## 四、冒烟 + 实测结论

- 完整构建（`build:lib:host`，类型全绿）+ `web-search-deepseek`(62) + `web`/`tool-web`(280) 测试全绿。
- 代码探针实测 Ark `/api/coding/v3/chat/completions` + `deepseek-v4-flash`：
  - 普通查询 → 模型**拒绝实时搜索**（"无法直接执行实时联网搜索"），按记忆作答，0 链接。
  - 带 "Cite source URLs" 提示 → 3 条 URL，但都是 **Bing/百度/Google 的搜索页链接**，不是真实检索引用——模型在"编造"查询链接。

**结论：Ark 的 chat-completions 网关不能作为真实 web 搜索后端**——给出的"来源"是幻觉/搜索引擎查询链接，会误导。

**方向调整（用户拍板）**：不把搜索绑在任何单一厂商上。最终采用**自研多引擎搜索聚合器** `@deepseek-ai/dsh-web-search-aggregator`（`packages/web/web-search-aggregator`）：引擎适配器层 + 有序回退链，免密钥档（duckduckgo/mojeek）为默认、自托管档（searxng）、商用档（brave/bing/tavily）按 key 激活；base 编排 `searchProvider` 指向聚合器。`web-search-deepseek` 的 OpenAI 方言/注册表改造保留为可选（可切回 deepseek-official）。
详见包 README（`packages/web/web-search-aggregator/README.md`）。