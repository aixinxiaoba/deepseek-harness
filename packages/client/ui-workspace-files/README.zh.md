# @deepseek-ai/dsh-client-ui-workspace-files

[English](README.md) | 中文

工作空间文件面板：侧栏底部动作打开一个 shell 浮层抽屉，浏览**当前会话的工作空间**——懒展开的目录树（行级大小元数据）、文本/代码预览（行号 + 扩展名语法高亮）、图片预览（走 Host GET 路由的原生 `<img>`，点击缩放）、隐藏文件开关。**客户端 UI** 包：注册两个槽位、不拥有 host 行为；受 confinement 的浏览原语在 `@deepseek-ai/dsh-host-workspace-files`。

## 组合

| 席位 | 类型 | 条目 |
|---|---|---|
| `sidebar.footer.action` | list | 开关按钮（窄栏图标，宽栏图标 + 标签） |
| `shell.overlay` | list | 抽屉（遮罩 + Esc 关闭；在点击穿透的浮层层上自选指针事件） |

浏览根是当前会话记录的 cwd——由 Host 侧解析并 confinement；无 cwd 的会话显示空态。切换会话重置目录树。每种失败按 Host 业务码（`workspace-files-*`）映射为本地化提示。

## 配置

```yaml
- id: ui-workspace-files
  name: '@deepseek-ai/dsh-client-ui-workspace-files'
```

面板自身无配置；服务上限（`maxEntries`、`maxTextBytes`、`maxImageBytes`）属于 Host 服务。

## 已知限制

- 图片缩放浮层为包内自实现（attachment 包的灯箱是其表面内部件；不做跨包 UI 伸手）。
- 文本预览行数来自返回的头部；截断文件显示面板自己的截断提示而非总行数。
- 目录展开状态是组件局部的，随浏览根（会话/cwd）变化重置，不跨抽屉关开保留。
