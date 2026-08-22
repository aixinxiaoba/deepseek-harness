/**
 * The workspace directory tree: lazily expanded levels over the wire listing,
 * a hidden-files toggle, and per-row metadata (size, mtime). Expansion state
 * and the level cache are plain React state keyed by absolute directory path;
 * the caller resets both when the browsing root changes (session/cwd switch).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { IconChevronRightOutline14, IconTriangleRightFill14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId, WorkspaceFileEntryView, WorkspaceFileListingView } from '@deepseek-ai/dsh-client-runtime/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
import { WorkspaceFilesBrowseError } from '@deepseek-ai/dsh-client-runtime/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from './WorkspaceFiles.module.css'

/** One cached level: the listing or the failure that replaced it. */
type Level = { status: 'loading' } | { status: 'ok'; listing: WorkspaceFileListingView } | { status: 'error'; code: string }

/** Sort a level's rows for display: directories first, then name order. */
function displayOrder(entries: readonly WorkspaceFileEntryView[]): WorkspaceFileEntryView[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

/** Format a byte size for the row metadata line. */
export function formatSize(size: number | undefined, t: TranslateNS<'workspace-files'>): string {
  if (size === undefined) return ''
  if (size < 1024) return t('size.bytes', { size: String(size) })
  if (size < 1024 * 1024) return t('size.kb', { size: (size / 1024).toFixed(1) })
  return t('size.mb', { size: (size / (1024 * 1024)).toFixed(1) })
}

/** Tree props: the browsing root's session + root path, the wire service, selection, and locale. */
export interface WorkspaceFileTreeProps {
  /** The session whose workspace is browsed. */
  sessionId: SessionId
  /** The canonical workspace root path (the first level shown expanded). */
  rootPath: string
  /** The wire-facing workspace service. */
  workspaces: IWorkspaces
  /** Currently selected file entry, if any (drives the preview). */
  selected: WorkspaceFileEntryView | undefined
  /** Select one file row for preview (directories toggle expansion instead). */
  onSelect: (entry: WorkspaceFileEntryView) => void
  /** Locale bound to the panel namespace. */
  t: TranslateNS<'workspace-files'>
}

/**
 * Render the workspace tree.
 * @param props - see {@link WorkspaceFileTreeProps}.
 * @returns the tree element.
 */
export function WorkspaceFileTree({ sessionId, rootPath, workspaces, selected, onSelect, t }: WorkspaceFileTreeProps) {
  const [levels, setLevels] = useState<Map<string, Level>>(() => new Map())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([rootPath]))
  const [showHidden, setShowHidden] = useState(false)
  const rootRef = useRef({ sessionId, rootPath })
  rootRef.current = { sessionId, rootPath }
  // One fetch per directory per root lifetime; the set reseeds on root change.
  const requestedRef = useRef<Set<string>>(new Set())

  const loadLevel = useCallback(async (dir: string, signal: AbortSignal) => {
    const requestSession = sessionId
    try {
      const listing = await workspaces.listWorkspaceFiles(sessionId, dir, signal)
      // A root switch raced this fetch: its result belongs to the old tree.
      if (rootRef.current.sessionId !== requestSession) return
      setLevels(prev => new Map(prev).set(dir, { status: 'ok', listing }))
    } catch (error) {
      if (signal.aborted || rootRef.current.sessionId !== requestSession) return
      const code = error instanceof WorkspaceFilesBrowseError ? error.rpcError.code : 'internal'
      setLevels(prev => new Map(prev).set(dir, { status: 'error', code }))
    }
  }, [sessionId, workspaces])

  // Load every expanded-but-unrequested level; the abort chain supersedes on
  // unmount so a departed drawer stops fetching.
  useEffect(() => {
    const controller = new AbortController()
    for (const dir of expanded) {
      if (requestedRef.current.has(dir)) continue
      requestedRef.current.add(dir)
      setLevels(prev => new Map(prev).set(dir, { status: 'loading' }))
      void loadLevel(dir, controller.signal)
    }
    return () => { controller.abort() }
  }, [expanded, loadLevel])

  // A root change (session or cwd switch) resets the whole tree.
  useEffect(() => {
    const root = rootRef.current
    if (root.sessionId === sessionId && root.rootPath === rootPath) return
    requestedRef.current = new Set([rootPath])
    setLevels(new Map())
    setExpanded(new Set([rootPath]))
  }, [sessionId, rootPath])

  const toggleDir = useCallback((dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })
  }, [])

  const visible = useCallback((entry: WorkspaceFileEntryView) => showHidden || !entry.hidden, [showHidden])
  const rootListing = levels.get(rootPath)
  const rootTruncated = rootListing?.status === 'ok' && rootListing.listing.truncated

  const rows = useMemo(() => {
    const out: { entry: WorkspaceFileEntryView; depth: number; listing: WorkspaceFileListingView | undefined }[] = []
    const walk = (dir: string, depth: number) => {
      const level = levels.get(dir)
      if (level?.status !== 'ok') return
      for (const entry of displayOrder(level.listing.entries)) {
        if (!visible(entry)) continue
        out.push({ entry, depth, listing: level.listing })
        if (entry.kind === 'directory' && expanded.has(entry.path)) walk(entry.path, depth + 1)
      }
    }
    walk(rootPath, 0)
    return out
  }, [levels, expanded, rootPath, visible])

  return (
    <div className={css.tree}>
      <div className={css.treeToolbar}>
        <label className={css.hiddenToggle}>
          <input type="checkbox" checked={showHidden} onChange={() => { setShowHidden(!showHidden) }} />
          {t('tree.showHidden')}
        </label>
      </div>
      <div className={css.treeBody} role="tree" aria-label={t('tree.label')}>
        {rootListing?.status === 'loading' && <div className={css.treeNotice}>{t('tree.loading')}</div>}
        {rootListing?.status === 'error' && <div className={css.treeNotice}>{t('error.access')}</div>}
        {rows.map(({ entry, depth }) => (
          entry.kind === 'directory'
            ? (
              <button
                type="button"
                key={entry.path}
                role="treeitem"
                aria-expanded={expanded.has(entry.path)}
                className={css.treeRow}
                style={{ paddingLeft: 8 + depth * 14 }}
                onClick={() => { toggleDir(entry.path) }}
              >
                {expanded.has(entry.path)
                  ? <IconChevronRightOutline14 className={clsx(css.chevron, css.chevronOpen)} />
                  : <IconTriangleRightFill14 className={css.chevron} />}
                <span className={clsx(css.rowName, css.rowDir)}>{entry.name}</span>
              </button>
            )
            : (
              <button
                type="button"
                key={entry.path}
                role="treeitem"
                aria-selected={selected?.path === entry.path}
                className={clsx(css.treeRow, selected?.path === entry.path && css.rowSelected)}
                style={{ paddingLeft: 8 + depth * 14 }}
                onClick={() => { onSelect(entry) }}
              >
                <span className={css.chevronSpacer} />
                <span className={css.rowName}>{entry.name}</span>
                <span className={css.rowMeta}>{formatSize(entry.size, t)}</span>
              </button>
            )
        ))}
        {rootTruncated && <div className={css.treeNotice}>{t('tree.truncated')}</div>}
        {rootListing?.status === 'ok' && rows.length === 0 && <div className={css.treeNotice}>{t('tree.empty')}</div>}
      </div>
    </div>
  )
}
