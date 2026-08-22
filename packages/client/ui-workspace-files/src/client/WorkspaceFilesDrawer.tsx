/**
 * The workspace files drawer: a right slide-over in the shell's overlay
 * layer. The layer is click-through, so the drawer opts back into pointer
 * events on its scrim and panel. Escape and scrim press close; the current
 * session's cwd is the browsing root (root-scope slot, useSessions reads
 * the standard feed); a session without a cwd shows the empty state.
 */
import { useEffect, useState } from 'react'
import { useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceFileEntryView } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceFilesInjected } from './inject.ts'
import { WorkspaceFileTree } from './WorkspaceFileTree.tsx'
import { FilePreview } from './FilePreview.tsx'
import css from './WorkspaceFiles.module.css'

/** Drawer props: the overlay runtime share (useSessions arrives standard) + injected face + locale seat. */
export type WorkspaceFilesDrawerProps =
  & PropsRuntime<'shell.overlay'>
  & WorkspaceFilesInjected
  & PropsLocale<'workspace-files'>

/**
 * Render the drawer (nothing while closed — the overlay layer stays clean).
 * @param props - see {@link WorkspaceFilesDrawerProps}.
 * @returns the drawer element, or null while closed.
 */
export function WorkspaceFilesDrawer({ controller, workspaces, t, useSessions }: WorkspaceFilesDrawerProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const sessions = useSessions(feed => feed)
  const [selected, setSelected] = useState<WorkspaceFileEntryView | undefined>(undefined)
  // The selected row belongs to the browsed session: dropping the selection on
  // session change keeps the preview from flashing another workspace's file.
  useEffect(() => { setSelected(undefined) }, [sessions.current])

  // Escape closes while open (the lightbox owns its own Escape while zoomed).
  useEffect(() => {
    if (!state.open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') controller.close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [state.open, controller])

  if (!state.open) return null

  const session = sessions.current === undefined ? undefined : sessions.byId[sessions.current]
  const cwd = session?.cwd

  return (
    <div className={css.drawerRoot}>
      <div className={css.scrim} onClick={() => { controller.close() }} aria-hidden="true" />
      <aside className={css.drawer} role="dialog" aria-label={t('drawer.title')} data-open={state.open}>
        <header className={css.drawerHeader}>
          <span className={css.drawerTitle}>{t('drawer.title')}</span>
          <button
            type="button"
            className={css.drawerClose}
            aria-label={t('drawer.close')}
            onClick={() => { controller.close() }}
          >
            <IconCloseOutline16 size={16} />
          </button>
        </header>
        {cwd === undefined || sessions.current === undefined
          ? <div className={clsx(css.drawerBody, css.treeNotice)}>{t('drawer.empty')}</div>
          : (
            <div className={css.drawerBody}>
              <WorkspaceFileTree
                sessionId={sessions.current}
                rootPath={cwd}
                workspaces={workspaces}
                selected={selected}
                onSelect={setSelected}
                t={t}
              />
              {selected !== undefined && (
                <FilePreview
                  sessionId={sessions.current}
                  entry={selected}
                  workspaces={workspaces}
                  t={t}
                />
              )}
            </div>
          )}
      </aside>
    </div>
  )
}
