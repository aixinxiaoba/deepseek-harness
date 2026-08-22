# @deepseek-ai/dsh-host-workspace-files

[English](README.md) | 中文

Web UI 工作空间文件面板背后的 host 侧服务：对会话项目目录做受 confinement 的列举、有上限的文本读取、带封顶的图片下发。**实现**包——注册 `ctx.workspaceFiles`，不拥有面向模型的工具。UI 面板本体在 `@deepseek-ai/dsh-client-ui-workspace-files`。

## 为什么需要它

目录选择器的 `listDirectory` 只服务单层子**目录**——文件面板需要文件、大小与修改时间，而 harness 此前根本没有把工作空间文件**内容**下发给 UI 的通道（attachment 是存储引用、从不下发）。本包补上这一缺口而不扩大影响面：它下发的一切都限定在该会话自己的工作空间内。

## 安全模型

- **根由 host 侧解析**：浏览根是会话 header 记录的 `cwd`；客户端只提供会话 id 和候选路径——永远无法指定根。
- **每请求 containment**：候选路径先 `realpath` 规范化，再用 `isPathUnder`（词法快路径 + 文件系统身份遍历，识别 Windows 大小写/8.3 别名）检查在规范根之下。逃出工作空间的符号链接会解析到界外，在任何字节被读取前即被拒。相对路径或无盘符路径直接拒绝（绝不在进程 cwd 下重定基）。
- **有界表面**：列举在 `maxEntries` 截断并置 `truncated`；文本读取有字节上限并做 NUL 二进制拒绝；图片按扩展名白名单（content type 来自扩展名、绝不嗅探字节）且打开前先查尺寸上限。

## 配置

```yaml
- id: workspace-files
  name: '@deepseek-ai/dsh-host-workspace-files'
  config:
    maxEntries: 1000
    maxTextBytes: 65536
    maxImageBytes: 3500000
```

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `maxEntries` | `1000` | 单层列举的完整结果上限（隐藏行计入）。 |
| `maxTextBytes` | `65536` | 单次文本读取的字节上限；更长的文件返回头部并置 `truncated`。 |
| `maxImageBytes` | `3500000` | 单张下发图片的字节上限（与 attachment 存储的图片上限一致）。 |

## 错误

`WorkspaceFilesError` 携带封闭错误码：`workspace-session-not-found`、`workspace-session-without-cwd`、`workspace-denied`（非完全限定路径，或解析到工作空间之外）、`workspace-not-found`（目标缺失、非目录/非文件、非图片扩展名）、`workspace-not-text`、`workspace-too-large`、`workspace-unreadable`。

## 已知限制

- mtime 不在 `ctx.fs` seam 上，因此本后端直接使用 `node:fs/promises`（目录选择器 browse 后端做了同样的取舍）。
- 符号链接的列举行报告其目标的形态；逃逸链接在访问时被拒，而非在列举时隐藏。
- Windows 隐藏属性文件不会被标记为 hidden（dirent 不暴露该属性）；只识别点前缀约定。
