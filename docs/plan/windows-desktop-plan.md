# 方案：把 dsh 做成 Windows 桌面应用（Agent 工作台）

> 项目：deepseek-harness（fork 自 deepseek-ai/deepseek-harness，远端 aixinxiaoba/deepseek-harness）
> 生成日期：2026-08-16
> 状态：方案已确认方向（Agent 工作台），待执行

## 产品定位

**Agent 工作台**：聊天式图形界面，用户监督 agent 干活（类似 ChatGPT / Claude 桌面版）。不是编辑器式（仿 Cursor），不是终端式（Claude Code CLI）。

## 目标

产出一个 Windows `.exe` 安装包，用户双击安装后打开原生窗口即可使用 dsh：
- 无需安装 Node.js / pnpm
- 无需打开终端、无需记端口
- 每个用户自带模型 API key

## 技术形态

- **dsh 宿主**：本地 `127.0.0.1` 服务（`dsh web`，默认端口 3080）
- **前端**：dsh 现有 Web UI（React SPA，`apps/web` + `packages/client`），零改动
- **壳**：Electron，main 进程拉起宿主进程，BrowserWindow 加载 Web UI

## 实施步骤

| 步骤 | 内容 | 耗时预估 |
|---|---|---|
| 1. 升级环境 | Node 20 → 22.19+；pnpm 8 → 11（dsh 硬性要求） | 5-10 min |
| 2. 构建 dsh | `pnpm install && pnpm run build`，跑通 `dsh web` | 10-30 min |
| 3. 写 Electron 壳 | 新建 `apps/desktop/`：main 进程拉起宿主 → BrowserWindow 加载 UI；窗口关闭联动退出宿主 | 1-2 h |
| 4. 打包配置 | electron-builder → NSIS 安装包（`.exe`） | 30 min |
| 5. 验证 | 开发模式跑通 → 打包 → 安装运行验证 | 30 min |

## Electron 壳结构（步骤 3 设计）

```
apps/desktop/
  package.json          # electron + electron-builder 依赖
  main.js               # 主进程：spawn dsh 宿主、端口就绪检测、创建窗口、退出清理
  preload.js            # （如需）桥接 IPC
  build/                # 图标等资源
  electron-builder.yml  # 打包配置（NSIS）
```

要点：
- 宿主进程生命周期管理：启动 → 探测 `127.0.0.1:3080` 就绪 → 加载 UI；窗口关闭时 kill 宿主
- 宿主只绑定 `127.0.0.1`，不暴露局域网
- 打包时带 dsh 构建产物（`apps/cli` 可执行入口 + 依赖）

## 风险与对策

| 风险 | 对策 |
|---|---|
| 首次 `pnpm install` + 全量构建耗时长/失败 | 走代理下载依赖；失败时逐项排查 |
| Electron 壳的宿主进程生命周期 bug | 就绪探测 + 退出钩子重点测试 |
| 原生依赖（Windows ACL 沙箱、Linux landlock） | Windows 走 ACL；Linux landlock 不影响 Windows 包 |
| dsh 预览期频繁破坏性变更 | 锁版本号，不随用随更 |
| 模型成本走用户各自 key | 文档写明"每人配 key" |

## 决策记录

- [x] 产品定位：Agent 工作台（聊天式图形界面）
- [x] 技术路线：dsh + Electron（不 fork VS Code；后续如需编辑器体验再考虑嵌 Monaco）
- [x] Node 环境：本地独立 Node 22.23.2（`.tools/`，不修改系统 v20）+ pnpm 11.7.0
- [ ] 安装包形式：默认 NSIS 单文件 `.exe`

## 进展更新（2026-08-17）

- ✅ 环境升级（独立 Node 22.23.2 + pnpm 11.7.0，系统 v20 未动）
- ✅ dsh 全量构建成功，`dsh web` 本地服务验证通过（127.0.0.1:3080 → HTTP 200）
- ✅ Electron 壳（apps/desktop，main.js + electron-builder.yml）开发模式跑通
- ⚠️ **Windows 打包暂停**：`pnpm deploy` 生成的 dsh 运行时闭包不完整——大量 `workspace:*` 的 **peer 依赖包**（cordis-plugin-group、dsh-scope、dsh-timeout、dsh-sandbox 等）未被打包进闭包，导致宿主启动时 `ERR_MODULE_NOT_FOUND`。逐一补齐成本高。
- 🔀 **当前策略调整为 CLI 方式使用 dsh**：构建后用 `.tools` 独立 Node 运行 `apps/cli/lib/bin.js`，提供根目录 `dsh.cmd` 包装脚本。

### 打包问题待解（若后续恢复）

1. `pnpm deploy` 不提升工作区 peer 包 → 需 `inject-workspace-packages: true` 或手动补齐缺失包（可从工作区根 node_modules 复制）
2. **改用 `pnpm pack` 逐个打包 + 干净消费者项目安装（已确定采用，见下）**
3. Electron 壳 main.js 中打包路径需与最终运行时结构对齐（resources/dsh/lib/bin.js）

## 架构决策更新（2026-08-17）

- **使用者**：外部用户（非自用/小团队）
- **目标**：方便持续更新应用
- **结论**：不做服务端多租户（外部 AI 编程工具应本地运行，操作用户本机代码）；采用 **薄壳 + 可更新引擎** 架构
- **形态**：免安装（portable 单 exe / 免安装目录 zip），用户双击即用、无需 Node
- **更新机制**：Electron 薄壳（~100MB，稳定）不变；dsh 运行时做成**版本化 zip 包**，客户端启动时从更新服务器检查/下载/原子替换
- **模型接入（两种都支持）**：① 用户自带 key（设置里填）；② 你的模型代理端点（LLM 适配器指向代理，你出成本+计费/限流）

## P2 设计决策（2026-08-17，已确认）

- **更新服务器**：用户已有 VPS 静态托管（nginx/静态目录，放 `update.json` + 运行时 zip）
- **更新策略**：启动自动检查；后台下载 → SHA256 校验 → 暂存 → 下次启动时（宿主未运行）原子替换 → 提示重启生效
- **更新 URL**：可配置（配置文件 `userData/config.json` 的 `updateUrl`，或 `DSH_UPDATE_URL` 环境变量）
- **版本方案**：`dsh-runtime-<runtimeVersion>.zip` + `update.json`；运行时内置 `version.json` 记录当前版本，客户端启动比对
- **失败安全**：下载失败/校验不通过 → 用旧版继续，暂存更新不落地
- **产物**：`desktop/build-update.mjs` 把 `.tools/dsh-runtime` 打成 zip + 生成 update.json（url 用相对路径，客户端按 UPDATE_URL 基址解析）

### P2 实施步骤

1. `desktop/build-update.mjs`：打包 zip + 生成 update.json + 写入 version.json
2. `desktop/main.js`：启动时应用暂存更新 → 启动宿主 → 后台检查更新/下载/暂存
3. 模型双接入：确认 dsh 模型 provider 配置方式 → 加"你的代理"provider preset（BYO key 走 dsh 自带设置）
4. VPS 托管说明文档
5. 联调：改版本号 → 验证客户端自动更新

### 实施阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 解决 dsh 运行闭包：`pnpm pack`（dsh+vendor 家族）→ 干净目录 `npm install` → 验证 `web` | ✅ 完成 |
| P1 | Electron 薄壳 + 内置 P0 运行时，portable/zip 免安装 | ✅ 完成（后改 NSIS，见下） |
| P2 | 更新服务器 + 运行时包自动下载替换 + 模型双接入 | ✅ 完成 |
| P3 | 代码签名（SmartScreen）、砍 Claude Code 集成减体积、计费限流、美化 | 待做 |

### 分发形态决策更新（2026-08-17 晚）

- ❌ **放弃 portable 单文件 exe**：每次启动自解压 ~1GB，Windows Defender 实时扫描下耗时 10 分钟以上，不可用
- ✅ **改用 NSIS 安装器**（`DeepSeek Harness Setup 0.1.0.exe`，248.7MB）：
  - 按用户安装（`%LOCALAPPDATA%\Programs\`），无需管理员
  - **实测**：静默安装（`/S`）→ 开始菜单快捷方式 → **启动 8 秒**（portable 是 10 分钟+）
  - **安装目录用户可写**（实测），运行时更新器无需提权即可替换引擎
  - zip 目标保留（给不能装软件的用户做备选）
- 已知小瑕疵：本次安装目录名为 `@deepseek-aidsh-desktop`（取自包名）；已把 `desktop/package.json` 的 name 改为 `dsh-desktop`，**下次重打包后**新安装目录为正常名称（改动已就位，尚未重打包）
- 服务器驱动的引擎更新与 NSIS 完全兼容：安装器只管首次交付，日常迭代全走 VPS 上的 update.json + 引擎 zip

### P2 完成记录（2026-08-17）

- ✅ `desktop/build-update.mjs`：运行时打版本化 zip + `update.json`（含 SHA256/大小）；实测 192MB zip
- ✅ `desktop/updater.cjs`：客户端更新器（检查/下载/校验/暂存/启动时原子替换/失败回滚）
- ✅ `desktop/main.js` 接入：启动先应用暂存更新 → 起宿主开窗口 → 后台检查更新 → 弹窗提示重启
- ✅ `desktop/serve-update.mjs`：本地更新服务器（联调）
- ✅ **端到端联调通过**：本地 `.2` 应用 + 服务器 `.3` 清单 → 自动下载暂存 → 重启替换 → 新运行时启动 HTTP 200
- ✅ 模型双接入：确认**无需改源码**——用户自带 key 默认支持；代理接入改 `llm-deepseek.baseURL`（settings namespace，即时生效），详见 `update-and-model-setup.md`
- ✅ 部署文档：`docs/plan/update-and-model-setup.md`（VPS nginx 配置、发布流程、模型双接入、本地联调）

P2 关键经验：
1. **跨盘 EXDEV**：`%APPDATA%`（C:）暂存目录 → 应用资源（D:）不能用 `renameSync`，改 `cpSync` 递归复制
2. Electron userData 目录名取自 package.json 的 name（`@deepseek-ai\dsh-desktop`），不是 productName
3. npmmirror.com 镜像主站不稳定时的替代：`cdn.npmmirror.com/binaries/`（electron + electron-builder-binaries 都可用）
4. Windows Defender 对新解压的大目录有瞬时锁（EPERM），构建重试即可
5. 打包应用的 console 输出不可见，更新器失败要靠独立运行 `updater.cjs`（`DSH_RUNTIME_DIR` 覆盖）来暴露错误

### P1 完成记录（2026-08-17）

- ✅ `desktop/`（Electron 薄壳）：main.js + electron-builder.yml + after-pack.cjs + build-runtime.mjs
- ✅ 产物（`.tools/release/`）：
  - `DeepSeek Harness 0.1.0.exe`（portable 单文件，**下载 197.5 MB**）
  - `DeepSeek Harness-0.1.0-win.zip`（免安装目录，**下载 337.8 MB**）
  - 安装后磁盘占用 ~1 GB（运行时 612MB + Electron 200MB + node 83MB）
- ✅ 运行验证：win-unpacked 启动 → 内置 node 拉起 dsh 宿主 → 127.0.0.1:3080 HTTP 200 → 窗口加载完整 dsh UI（zh-CN）
- 打包关键经验：
  1. electron-builder 的 **extraResources 会应用 `.gitignore`**（`node_modules/` 被排除），612MB 运行时无法用 extraResources 复制 → 改用 **`afterPack` 钩子**（`desktop/after-pack.cjs`）直接复制进 `resources/`
  2. 运行时顶层 package.json 需删除（build-runtime.mjs 已自动处理）
  3. `win-unpacked` 目录被 Windows Defender 锁定导致 EPERM → 每次构建前先删除旧目录

### P0 完成记录（2026-08-17）

- ✅ `pnpm pack` dsh 家族 221 包 + vendor 家族 9 包 → `.tools/npm/`
- ✅ `desktop/build-runtime.mjs`：收集全部 tarball → 干净目录 `.tools/dsh-runtime/` 用 **npm install** 安装（npm 正确解析 peer 依赖，闭包完整）
- ✅ 验证：`dsh --version` → 0.1.0-rc.5；`dsh web` → 127.0.0.1:3080 HTTP 200
- ✅ 原生库：koffi（`@koromix/koffi-win32-x64` 预编译包）、node-pty（ConPTY）均加载正常
- 产物：`.tools/dsh-runtime/`（612MB，自包含可运行 dsh）
- 关键经验（Windows 构建坑）：
  1. Node `spawnSync` 不能直接跑 `.cmd` → 用独立 `pnpm.exe`（`@pnpm/exe` + 同目录 `dist/`）或 `node npm-cli.js`
  2. 仓库 release 脚本的 `tar` 必须用 `C:\Windows\System32\tar.exe`（bsdtar），Git for Windows 的 GNU tar 会把 `D:` 当远程主机
  3. koffi 预编译包是 optional 依赖 `@koromix/koffi-win32-x64` → npm 不能加 `--omit=optional`
  4. 网络：npm registry 用国内源 `registry.npmmirror.com`，直连无需代理；仅 GitHub 需要代理

## 相关文档

- 项目解析：`docs/summary/project-summary.md`
- 上游架构：`docs/architecture.md`
