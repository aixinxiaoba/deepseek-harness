# DeepSeek Harness 项目解析

> 来源：对本仓库 `D:\work\deepseek-harness`（deepseek-ai/deepseek-harness）的代码与文档解析。
> 生成日期：2026-08-16

## 是什么

**DeepSeek AI 开源的 Agent 运行时框架**（agent harness），相当于一个可插拔、可自托管的 "Claude Code / OpenAI Codex" 开源替代品。核心设计哲学是 **"一切皆插件"（everything is a plugin）**：模型适配器、工具注册表、会话日志、甚至 agent 主循环本身都是插件，因此**每个部件都可以从配置层面替换**，没有需要打补丁的"特权核心"。

## 技术基础

- 基于 **Cordis** 插件框架（依赖注入 + 可逆 effect 注册），TypeScript 为主
- Monorepo：pnpm workspace，**约 150+ 个 `@deepseek-ai/*` 包**
- Node ^22.19+，构建工具 tsc + tsdown，测试 vitest，lint oxlint
- 另有 Rust 原生组件（`native/landlock-run`，Linux Landlock 沙箱）和 Python SDK（`python/`）
- 当前版本 **v0.1.0-rc.5**，开发者预览阶段，频繁破坏性变更

## 目录结构

| 目录 | 内容 |
|---|---|
| `packages/` | 核心插件库，按领域划分 |
| `apps/cli` + `apps/web` | CLI 命令行和 Web UI（React） |
| `native/landlock-run` | Rust 编写的 Linux 进程沙箱 |
| `python/` | Python SDK 和运行时 |
| `website/` + `docs/` | VitePress 文档站 + 极详尽的架构文档 |
| `vendor/` | 第三方依赖（rescoped 后引入） |

## 核心能力（从包结构可看出）

- **LLM 适配**：deepseek、pi-ai、retry、token 计量
- **工具系统**：文件系统、bash/pwsh shell、持久终端、Web 搜索（deepseek/exa/perplexity）、LSP、**MCP client**、subagent（子代理）、workflow、goal、skill、todo
- **沙箱/安全**：本地沙箱、e2b 云沙箱、Landlock（Linux）、Windows ACL、审批策略
- **会话层**：可重放的 append-only 会话日志、jsonl/sqlite 持久化、OTel 遥测、checkpoint、compaction
- **生态兼容**：提供 `hooks-claude-code` / `hooks-codex`——可桥接 Claude Code 和 Codex 生态；支持 ACP（Agent Client Protocol）
- **UI**：完整 Web 界面（会话、工具轨迹、设置、插件管理、工作区等 40+ 个 ui-* 组件）

## 核心架构概念

- **Profile / Bundle**：一个运行的 dsh 是由 bundle（分发包）按层叠顺序组合成的插件树；`dsh-base`（基础层：模型/工具/持久化/沙箱）、`dsh-web-app`（浏览器应用）、`dsh-headless`（无服务器一次性运行器）
- **事件驱动**：会话事件（持久事实）、agent 事件（飞行中拦截）、能力事件（政策/适配器挂接），每个功能都挂在文档化的扩展点上
- **"模型可见即记录"** 不变量：模型看到的任何内容都必须是可从会话日志重建的
- **Seam（接缝）模式**：文件系统/子进程/沙箱都通过"服务定义 + 提供者 + 消费者"三件套交换实现

## 运行方式

```sh
npx @deepseek-ai/dsh web     # 启动 Web UI，默认 http://127.0.0.1:3080
# 或从源码：pnpm install && pnpm run build && pnpm dsh web
```

## 一句话总结

这是 DeepSeek 打造的、以插件化为核心的通用 agent 运行时/开发框架，可用浏览器 UI 或 headless 方式运行 agent，覆盖工具执行、沙箱安全、会话持久化、多模型适配的完整闭环，且架构上刻意与任何具体模型解耦。
