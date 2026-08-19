# DSH Desktop Pro —— 超越型桌面客户端设计（v1.0）

> 状态：M1 ✅｜M2 ✅｜P0-P2 ✅（2026-08-19 打包应用完整启动实证，见 optimization-plan 实战记录）｜P3 待做
> 日期：2026-08-19
> 参考：anywhere-labs/deepseek-harness-desktop（DSH Desktop）、本项目 P0-P2 全部实证
> 定位：**吸收同类产品精华、修正其架构短板**的自研桌面客户端，目标是同类中最优的更新机制与壳无关能力层

---

## 1. 目标与非目标

### 目标
1. 面向外部用户的 Windows（后续 macOS）桌面客户端，开箱即用（无需 Node/pnpm/DSH）
2. **引擎与壳彻底解耦**：dsh 引擎独立版本线，服务器随时推送，无需重发安装包
3. **包级增量更新**：常态更新 <10MB，后台预取，下次启动无感生效
4. **发布身份验证**：Ed25519 签名清单，无代码签名证书也具备强完整性保证
5. **壳无关桌面服务层**：更新/profile/托盘等能力为 Cordis 服务，Electron 仅为载体之一
6. 双模型接入：用户自带 key + 自有代理端点
7. 精简运行时：总体积目标 ~450MB（对比 DSH Desktop ~1GB）

### 非目标（当前版本）
- 不 fork、不修改上游源码（引擎用官方发布物）
- 不做移动端壳（架构预留，M4 再议）
- 不自建插件市场（兼容官方 `dsh plugin` 生态即可）

---

## 2. 总体架构

```
desktop-pro/                      ← 独立产品工作区（npm/yarn 管理，可整体迁出为独立仓库）
├── apps/shell/                   ← Electron 极薄引导（目标 <300 行）
│   ├─ 单实例锁、窗口创建、托盘入口、崩溃自恢复
│   ├─ Host Cordis 根在 Electron 主进程内启动（零子进程管理）
│   ├─ 随机回环端口 + 同源沙箱渲染器（contextIsolation/sandbox/无 nodeIntegration）
│   └─ 子进程经 ELECTRON_RUN_AS_NODE（不携带独立 node.exe）
├── packages/                     ← 每个都是合法 Cordis Host 插件（官方组合路径）
│   ├─ dsh-desktop-shell/         窗口/导航/关-退生命周期（Cordis effect 管理）
│   ├─ dsh-desktop-updates/       ctx.desktopUpdates：验签/增量/预取/回滚
│   ├─ dsh-desktop-profiles/      ctx.desktopProfiles：profile 管理 + 重启围栏
│   └─ dsh-desktop-onboarding/    首启向导（key/代理/镜像源）
├── engine/                       ← 官方 @deepseek-ai/dsh 发布版（锁定版本，剪裁闭包）
└── infra/update-server/          版本 API + 签名发布流水线 + 频道/灰度
```

### 分层职责

| 层 | 职责 | 更新频率 |
|---|---|---|
| Shell（Electron 引导） | 窗口/托盘/进程内 boot | 极低（月/季） |
| 桌面插件（Cordis） | 桌面能力服务 | 低，随引擎线走 |
| 引擎（官方 dsh） | agent 全部能力 | 高（随上游/我们的定制） |
| 用户层（profile/数据） | 配置/会话/插件 | 用户自主 |

---

## 3. 关键决策记录（ADR）

### ADR-1 引擎来源：官方 npm 发布版，不再 fork 源码
- **决策**：引擎 = npm 安装的 `@deepseek-ai/dsh` 家族（锁版本）
- **理由**：上游已公开发布（rc.7+）；发布物接口即兼容契约；我们 P0 的"pack 230 tarball + 干净安装"流程已被验证等价，但直接用发布版省去整套源码构建
- **放弃的替代**：fork 源码构建（漂移风险、构建链复杂）；git submodule（DSH Desktop 方案，引擎版本与 app 版本耦合）

### ADR-2 Host 进程模型：Electron 主进程内启动 Cordis 根
- **决策**：不 spawn 外部 node 跑 CLI，直接在 Electron 主进程 import 引擎的 boot 入口
- **理由**：零进程管理（生命周期/僵尸进程/端口探测全消失）；Electron 37 内置 Node 22 与 NAPI 原生模块兼容
- **放弃的替代**：外部 spawn（我们 P1-P2 的做法，进程管理复杂、需独立 node.exe）
- **风险**：主进程崩溃 = 全崩 → 缓解：崩溃自恢复 + 优雅 dispose

### ADR-3 UI 载体：回环随机端口 + 同源沙箱渲染器
- **决策**：Host 绑 127.0.0.1 随机端口，BrowserWindow 加载同源页面；导航锁定该 origin
- **理由**：避开固定端口冲突（3080 已知问题）；零 Electron IPC/preload 桥（学 DSH Desktop 并保留）

### ADR-4 更新模型：包级增量 + Ed25519 签名 + 频道灰度 + 自动回滚
- **决策**：见 §4 更新协议规范
- **理由**：DSH Desktop 三大短板（全量更新/无发布者验证/引擎锁死）全部由此解决

### ADR-5 桌面能力形态：Cordis 服务，不绑 Electron
- **决策**：桌面插件只注册 `ctx.desktop*` 纯服务，Electron 壳是消费者
- **理由**：未来 TUI 壳/移动远程消费同一组服务，桌面能力零重写

### ADR-6 体积策略
| 项 | 手段 | 收益 |
|---|---|---|
| node.exe | ELECTRON_RUN_AS_NODE | -83MB |
| Claude Code 载荷 | 安装后剔除 `@anthropic-ai/claude-agent-sdk-*` 平台包（生产路径用本机 claude） | -253MB |
| 压缩 | NSIS 安装器 | 分发体积 |

---

## 4. 更新协议规范（v1）

### 4.1 清单格式（manifest.json）

```json
{
  "schema": 1,
  "channel": "stable",
  "sequence": 42,
  "runtimeVersion": "0.1.0-rc.7.3",
  "publishedAt": "2026-08-19T00:00:00Z",
  "packages": [
    { "name": "@deepseek-ai/dsh-agent-loop", "version": "0.1.0-rc.7", "integrity": "sha256-..." },
    { "name": "@deepseek-ai/dsh-tools", "version": "0.1.0-rc.7", "integrity": "sha256-..." }
  ],
  "rollout": { "percent": 100 }
}
```

签名：`manifest.sig` = Ed25519(minisign 风格)，对 manifest 规范化字节签名。公钥内置于壳，**不止验完整性，验发布者**。

### 4.2 状态机

```
IDLE → 检查(节流:启动+60s，此后每6h)
  → 拉取 manifest → Ed25519 验签 → 失败即弃(静默,保留可用版本)
  → 与本地 packages-index.json 做 diff
      → 无差异 → IDLE
      → 有差异 → 后台逐包下载到 staging/（每包独立 sha256 校验）
          → 全部就绪 → 状态=READY_TO_APPLY → 提示"重启后生效"（托盘角标）
  → 下次启动：宿主未运行 → 原子换入(cpSync+rename，跨盘安全) → boot 自检
      → 自检通过 → 清理 N-2 旧版，记录 last-known-good
      → 自检失败 → 自动回滚 N-1 → 上报(可选)
```

### 4.3 安全模型

| 威胁 | 缓解 |
|---|---|
| 更新服务器被入侵/中间人 | Ed25519 验签（私钥离线，仅发布机持有）；HTTPS |
| 恶意/损坏包 | 每包 sha256 + manifest 内 integrity 比对；暂存区不落地到运行目录 |
| 半更新状态 | staging 全量校验后才标记 READY；换入前宿主必须未运行 |
| 更新后无法启动 | boot 自检（关键文件存在性+版本号+最小 import 探测）失败自动回滚 N-1 |
| 本地数据 | 用户数据（profile/session/凭据）在 DSH home，永不随更新触碰 |

---

## 5. 实施里程碑与验收标准

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M1 骨架** | desktop-pro 工作区 + Electron 主进程内 boot + 随机端口 + 官方 npm 引擎 | ✅ **完成**：进程内 boot 15s 就绪，OS 随机端口（实测 55636），UI HTTP 200「DeepSeek Harness」，零子进程/零 node.exe。文件：`desktop-pro/{package.json,main.cjs}`，引擎=官方 npm `@deepseek-ai/dsh@0.1.0-rc.7`（811 包闭包） |
| **M2 更新** | 签名清单 + 包级增量 + 频道 + 回滚 | ✅ **完成（E2E 全过）**：1 包变更 ~KB 级下载 5s 暂存；重启原子应用+自检；EXDEV 失败自动回滚验证通过；篡改 manifest（Ed25519）拒绝验证通过。组件：`infra/keys.mjs`（密钥）、`infra/publish.mjs`（差异发布）、`infra/serve-updates.mjs`（更新服务器）、`updater.cjs`（客户端）。M2 补丁中修掉的坑：BOM'd package.json 毒化索引、跨盘备份 EXDEV、`.dsh-incoming` 残留污染扫描、引擎根传参错误 |
| **M3 产品** | 剪裁闭包 + 首启向导（key/代理）+ 日志/诊断 + NSIS | 总体积 ~450MB；无 key 引导；安装即用 |
| **M4 生态**（可选） | TUI 壳消费同一服务层；插件市场协议 | 后议 |

---

## 6. 工程标准（行业最高基准）

1. **门禁自动化**：runtime-closure verifier（缺 CLI 引导/更新模块/原生二进制 → 拒绝出包）
2. **测试**：单元（更新状态机/验签/diff）+ 冒烟（boot→UI→更新→回滚 全链路脚本化）
3. **发布流水线**：`build → verify → sign → upload → manifest bump`，一键可重复
4. **可观测**：日志轮转（10MiB/7天/200MiB 上限）+ 诊断 ZIP 导出（凭据脱敏）
5. **环境纪律**：图形启动 PATH 恢复 + 凭据洗刷白名单（学 DSH Desktop）
6. **文档**：ADR 全留痕；每次里程碑更新本文件状态

---

## 7. 风险与缓解

| 风险 | 概率 | 缓解 |
|---|---|---|
| 上游 npm 发布物缺包/接口变化 | 中 | M1 第一件事验证发布物可用；闭包 verifier 门禁 |
| Electron 主进程内 boot 的原生模块 ABI 问题 | 低 | Electron 37=Node22+NAPI；node-pty/koffi 均为 NAPI（DSH Desktop 已验证可行） |
| Ed25519 私钥管理 | 低 | 离线生成，发布机专用，公钥硬编码进壳 |
| Defender/SmartScreen | 高(已知) | NSIS 一次安装缓解；正式期购代码签名 |
| 单人维护带宽 | 中 | M1-M3 严格复用已验证原语；文档+记忆库完整 |

---

## 8. 与既有资产的关系

| 资产 | 去留 |
|---|---|
| `desktop/updater.cjs`（原子换入+回滚原语） | **复用**：M2 服务内核 |
| `desktop/build-runtime.mjs` / `build-update.mjs` | **退役**：改用官方发布版 + 新流水线 |
| P0-P2 全部文档与坑手册 | 保留，`docs/plan/` 续写 |
| 本 fork 仓库 | 转为上游研究/引擎实验场；desktop-pro 独立成区，可整体迁出 |
