# @deepseek-ai/dsh-client-ui-workspace-files

English | [中文](README.zh.md)

The workspace files panel: a sidebar footer action opening a shell-overlay drawer that browses the **current session's workspace** — a lazily expanded directory tree with per-row size metadata, text/code preview (line-numbered, extension-hinted highlighting), image preview (native `<img>` over the Host's GET route, click to zoom), and a hidden-files toggle. A **client UI** package: it registers two slots and owns no host behavior; the confined browsing primitives live in `@deepseek-ai/dsh-host-workspace-files`.

## Composition

| Seat | Kind | Entry |
|---|---|---|
| `sidebar.footer.action` | list | the toggle button (icon on the rail, icon + label when wide) |
| `shell.overlay` | list | the drawer (scrim + Esc close; pointer-events opt-in on the click-through overlay layer) |

The browsing root is the current session's recorded cwd — resolved and confined Host-side; a session without one shows the empty state. Switching sessions resets the tree. Every failure maps its Host business code (`workspace-files-*`) to a localized notice.

## Config

```yaml
- id: ui-workspace-files
  name: '@deepseek-ai/dsh-client-ui-workspace-files'
```

The panel has no config of its own; the serving bounds (`maxEntries`, `maxTextBytes`, `maxImageBytes`) are the Host service's.

## Known limitations

- The image zoom overlay is package-local (the attachment package's lightbox is internal to its surface; no cross-package UI reach).
- Text preview line count derives from the returned head; a truncated file shows the panel's truncated notice rather than a total-line count.
- Directory expansion state is component-local and resets with the drawer's root (session/cwd) change, not across drawer close/open.
