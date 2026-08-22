# @deepseek-ai/dsh-host-workspace-files

English | [中文](README.zh.md)

Host-side service behind the web UI's workspace files panel: confined listing of a session's project directory, bounded text reads, and capped image serving. An **implementation** package — it registers `ctx.workspaceFiles` and owns no model-facing tools. The UI panel itself lives in `@deepseek-ai/dsh-client-ui-workspace-files`.

## Why

The directory picker's `listDirectory` serves one-level child **directories** only — a files panel needs files, sizes, and modification times, and the harness had no channel that serves workspace file **content** to the UI at all (attachments are stored references, never served). This package fills that gap without widening the blast radius: everything it serves is confined to the session's own workspace.

## Security model

- **Root resolved host-side**: the browsing root is the session header's recorded `cwd`; a client supplies only a session id and a candidate path — it can never name a root.
- **Containment per request**: the candidate is `realpath`-canonicalized, then checked beneath the canonical root with `isPathUnder` (lexical fast path plus filesystem-identity walk for Windows casing/8.3 aliases). A symlink that escapes the workspace resolves outside and is denied before any byte is read. Relative or drive-less paths are refused outright (never rebased under the process cwd).
- **Bounded surfaces**: listings cut at `maxEntries` with a `truncated` flag; text reads are byte-capped with NUL-byte binary rejection; images are extension-allowlisted (content type comes from the extension, never sniffed from bytes) and size-capped before opening.

## Config

```yaml
- id: workspace-files
  name: '@deepseek-ai/dsh-host-workspace-files'
  config:
    maxEntries: 1000
    maxTextBytes: 65536
    maxImageBytes: 3500000
```

| Key | Default | Meaning |
|---|---|---|
| `maxEntries` | `1000` | Complete-result bound of one listing level (hidden rows count). |
| `maxTextBytes` | `65536` | Byte cap of one text read; longer files return their head with `truncated`. |
| `maxImageBytes` | `3500000` | Byte cap of one served image (matches the attachment store's image ceiling). |

## Errors

`WorkspaceFilesError` carries a closed code: `workspace-session-not-found`, `workspace-session-without-cwd`, `workspace-denied` (not fully qualified, or resolves outside the workspace), `workspace-not-found` (missing target, non-directory/non-file, non-image extension), `workspace-not-text`, `workspace-too-large`, `workspace-unreadable`.

## Known limitations

- mtime is not on the `ctx.fs` seam, so this backend talks to `node:fs/promises` directly (the directory-picker browse backend made the same call).
- The listing row of a symlink reports its target's shape; an escaping link is denied at access time, not hidden at listing time.
- Windows hidden-attribute files are not flagged hidden (dirents do not expose the attribute); only the dot-prefix convention is honored.
