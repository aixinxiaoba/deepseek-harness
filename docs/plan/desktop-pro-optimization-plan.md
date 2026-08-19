# Desktop Pro 最优性对齐计划（2026-08-19，已确认执行）

> 目标：零临时折中。A 类不动，B/C/D 类全部落地。
> 前置实证：插件 direct-import Electron 验证通过（mode: direct-electron），globalThis 桥确认多余。

## A. 已是最优（不动）

| 项 | 依据 |
|---|---|
| 进程内 boot | 零子进程/零 node.exe |
| npm 发布版引擎 | 闭包精选（Claude 载荷 0MB 实测） |
| 随机端口 + 同源沙箱 + 导航锁 | 最佳实践 |
| Ed25519 签名 + 包级增量 + 回滚 | 超越 DSH Desktop（其更新无签名、全量 250MB+） |

## B. 折中修复清单

| # | 问题 | 修复 | 状态 |
|---|---|---|---|
| B1 | 公钥外置磁盘可被替换 | 构建编译注入 embedded-key.cjs；打包态 fail-closed（只认内嵌） | ✅ |
| B2 | 无序列单调性（可被降级） | userData 记 lastSequence；manifest.sequence ≤ 拒绝 | ✅ |
| B3 | 下载串行 | 并发下载（limit 4） | ✅ |
| B4 | globalThis 桥残留 | 删除（direct-electron 已验证）；插件无绑定时硬失败 | ✅ |
| B5 | electron/builder 版本浮动 | 精确锁定（electron 37.10.3 / builder 26.15.3） | ✅ |
| B6 | 关窗即退、无托盘 | 关窗隐藏 + 托盘（显示/检查更新/退出）+ 5s 期限优雅 dispose | ✅ |
| B7 | 无日志系统 | 轮转 10MiB/7天/200MiB + error 流分离 + console 重定向 | ✅ |
| B8 | 渲染器权限未锁 | setPermissionRequestHandler 全拒 | ✅ |
| B9 | 服务器工件只增不减 | publisher 清理未引用工件 | ✅ |
| B10 | 更新只查一次 | 启动+60s，此后每 6h；托盘手动检查 | ✅ |

## C. 打包流程对齐（DSH Desktop 实证 + 自有教训）

| 项 | 动作 | 状态 |
|---|---|---|
| asarUnpack node_modules/** | Loader 需物理树（P1 extraResources 教训） | ✅ |
| afterPack 闭包校验门禁 | 缺 CLI 引导/更新器/内嵌公钥/插件/原生二进制 → 拒绝出包 | ✅（实战抓出 4 类缺陷：asar 库用法/路径格式/node-pty prebuilds 布局/peer 缺失） |
| electronFuses.runAsNode | 开启 | ✅ |
| NSIS useZip + differentialPackage:false | 压缩率对策（双向实证） | ✅ |
| oneClick 按用户安装 | **有意差异**：包级写入式更新需用户可写目录（对方重跑安装器式更新可提权装 Program Files，模型不同） | ✅ |
| 精确版本 + lockfile 严装 | electron 37.10.3 / builder 26.15.3 锁死 | ✅ |
| 图标流水线 + 工件命名 | 单源生成（build/icon.png + 内嵌托盘图） | ✅ |
| 公钥编译注入 | embedded-key.cjs + 门禁校验密钥内容 | ✅ |
| **全量闭包显式声明** | `infra/sync-engine-deps.mjs`：195 个 @deepseek-ai/* 全部声明为直接依赖（electron-builder 树遍历会剔除纯 peer——dsh-timeout/dsh-scope 等由此丢失；DSH Desktop 的巨型依赖清单正是此解法） | ✅ |

### P2 打包实战记录（2026-08-19）

- 产物：`DSH Desktop Pro Setup 0.1.0.exe`（**173.2MB**，NSIS oneClick 按用户安装）
- 关键坑与修复：
  1. `npmRebuild: false`——node-pty 1.1 是 prebuilds 布局（`prebuilds/win32-x64/conpty.node`），node-gyp 重编需 VS 且无必要
  2. **electron-builder 剔除纯 peer 依赖**（两次踩中：5 个 cordis 包 → 显式声明；随后 dsh-timeout/dsh-scope/dsh-session-title-llm 全线缺失 → sync-engine-deps.mjs 全量声明）
  3. afterPack 门禁里查 asar 内文件必须用 `@electron/asar`（`listPackage` win32 返回前导反斜杠路径）
  4. 打包应用读依赖必须走 `app.asar.unpacked` 物理路径（PHYSICAL_ROOT 适配）
  5. NSIS 7z 阶段偶发 exit 134 → 重试即过

## D. 架构收编（随 M3）

- desktop-shell / desktop-updates 插件化，暴露 ctx.desktop* 服务
- 首启向导（模型 key / 代理双接入）
- M3 出包 + 安装验证

## 执行批次

1. **P0**：B1 B2 B4 B5
2. **P1**：B3 B6 B7 B8 B9 B10
3. **P2**：C 全部 + 出包 + 门禁验证
4. **P3**：D + M3 收尾
