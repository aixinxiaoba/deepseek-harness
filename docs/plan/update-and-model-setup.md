# P2 部署说明：更新服务器 + 模型双接入

> 配套实现：`desktop/updater.cjs`（客户端更新逻辑）、`desktop/build-update.mjs`（打更新包）、`desktop/serve-update.mjs`（本地测试服务器）

## 一、更新服务器部署（VPS 静态托管）

### 1. 构建更新包

在开发机（本仓库）执行：

```sh
node desktop/build-runtime.mjs        # 生成 .tools/dsh-runtime（完整运行时闭包）
node desktop/build-update.mjs         # 打包 .tools/update/dsh-runtime-<版本>.zip + update.json
```

产物在 `.tools/update/`：
- `dsh-runtime-<runtimeVersion>.zip`（~192MB）
- `update.json`（清单：版本号、zip 相对路径、SHA256、大小）

### 2. 上传到 VPS

把这两个文件放到任意静态目录（nginx / caddy / 甚至 `python -m http.server`），例如：

```
https://updates.yourdomain.com/
├── update.json
└── dsh-runtime-0.1.0-rc.5.20260817.zip
```

nginx 最小配置示例：

```nginx
server {
    listen 443 ssl;
    server_name updates.yourdomain.com;
    root /var/www/dsh-updates;
    # 大文件下载建议开启
    sendfile on;
    tcp_nopush on;
}
```

### 3. 客户端配置更新地址

两种方式（优先级：环境变量 > 配置文件）：

- **环境变量**：`DSH_UPDATE_URL=https://updates.yourdomain.com`
- **配置文件**：`%APPDATA%\DeepSeek Harness\config.json`

```json
{ "updateUrl": "https://updates.yourdomain.com" }
```

不配置 = 不检查更新（用户自带 key 分发时可不配）。

### 4. 发布新版本流程

```sh
# 改代码 → 构建 → 打更新包（版本号递增）
node desktop/build-runtime.mjs
node desktop/build-update.mjs --version 0.1.0-rc.5.20260818
# 上传 .tools/update/ 下两个文件到 VPS（覆盖 update.json）
```

用户下次启动应用：后台检测到新版本 → 下载 → SHA256 校验 → 暂存 → 弹窗提示重启 → 重启后自动替换运行时。

### 5. 更新机制说明（安全设计）

- **非阻塞**：更新检查在 UI 启动后后台进行，不挡启动
- **失败安全**：下载/校验/解压任一失败 → 清理暂存、继续用旧版，绝不破坏现有运行时
- **原子替换**：新版先解压到 `userData/staged-update`，校验通过且宿主未运行时（下次启动）才整体换入；换入失败自动回滚
- **校验**：SHA256 + zip 内必须含 `node_modules/@deepseek-ai/dsh/lib/bin.js`（防止清单/包被篡改或打包错误）

### 6. 本地联调

```sh
node desktop/serve-update.mjs                      # 127.0.0.1:8931 托管 .tools/update
$env:DSH_UPDATE_URL = "http://127.0.0.1:8931"      # 指向本地
# 启动 .tools\release\win-unpacked\DeepSeek Harness.exe 观察更新流程
```

## 二、模型双接入

### 方式 A：用户自带 key（默认，零配置）

dsh 默认配置即指向 DeepSeek 官方 API。用户在 Web UI 设置里存入自己的 API key 即可：

- 端点：`https://api.deepseek.com`（默认）
- key 存储：dsh 的凭据管理（`ctx.credentials`），不落配置文件

### 方式 B：你的模型代理（统一计费/管控）

利用 dsh 现有的 `llm-deepseek` 适配器配置（**无需改源码**），把端点指向你的代理：

```yaml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    baseURL: https://api.yourdomain.com   # 你的 OpenAI 兼容代理端点
    apiKeyEnv: YOUR_PROXY_TOKEN           # 用户填你发的 token
```

或在用户运行时通过设置文档覆盖（settings namespace `llm-deepseek`，改完**即时生效无需重启**）：

```json
{ "llm-deepseek": { "baseURL": "https://api.yourdomain.com" } }
```

**你的代理需要**：实现 `/chat/completions`（OpenAI/DeepSeek 兼容 wire format，SSE 流式），鉴权用 Bearer token，按 token 计费/限流。

**两种方式可并存**：默认自带 key；你的用户群里分发带 preset 的版本（或让用户改一处 baseURL）即走代理。请求头会带 `x-deepseek-harness-user-id`（稳定匿名 id）和 `x-deepseek-harness-session-id`（会话 id），代理端可用来做用户级计量。

## 三、已验证情况（2026-08-17）

- ✅ `build-update.mjs`：产出 zip（192MB）+ update.json（SHA256 校验和）
- ✅ `serve-update.mjs`：本地服务器正常返回 manifest
- ✅ **端到端自动更新**：应用本地 `.2` + 服务器 `.3` → 启动后台下载/SHA256 校验/暂存 → 重启后自动替换 → 新运行时（`.3`）正常启动（HTTP 200）
- ✅ 失败安全验证：跨盘替换失败时自动回滚旧运行时，应用可正常启动
