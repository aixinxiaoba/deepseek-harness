/**
 * The panel's sidebar entry: a footer action button that toggles the
 * workspace files drawer. Wide sidebar renders icon + label; the collapsed
 * rail renders the icon alone inside a tooltip, matching the New Session
 * and Settings affordances.
 */
import { useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconFolderOpenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceFilesInjected } from './inject.ts'
import css from './WorkspaceFiles.module.css'

/** Button props: the footer-action owner share + injected face + locale seat. */
export type WorkspaceFilesButtonProps =
  & PropsRuntime<'sidebar.footer.action'>
  & WorkspaceFilesInjected
  & PropsLocale<'workspace-files'>

/**
 * Render the footer action that opens the workspace files drawer.
 * @param props - see {@link WorkspaceFilesButtonProps}.
 * @returns the toggle button.
 */
export function WorkspaceFilesButton({ wide, controller, t }: WorkspaceFilesButtonProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  return (
    <Tooltip label={t('entry.label')} delayMs={500} disabled={wide}>
      <button
        type="button"
        className={clsx(css.entryButton, state.open && css.entryActive)}
        aria-label={t('entry.label')}
        aria-pressed={state.open}
        onClick={() => { controller.toggle() }}
      >
        <IconFolderOpenOutline16 size={wide ? 16 : 18} />
        {wide && <span className={css.entryLabel}>{t('entry.label')}</span>}
      </button>
    </Tooltip>
  )
}
