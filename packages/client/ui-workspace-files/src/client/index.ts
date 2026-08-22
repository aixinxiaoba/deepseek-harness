/**
 * Browser half of the workspace files panel: a sidebar footer action that
 * opens a shell-overlay drawer browsing the current session's workspace.
 * Mounting this package composes the UI surface with the Host's confined
 * browsing service through the wire-facing workspaces methods — nothing here
 * touches the filesystem itself. Copy is locale-registered here.
 */
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the SlotMap merges declaring the two seats this fills.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { WorkspaceFilesPanelController } from './controller.ts'
import { WorkspaceFilesButton } from './WorkspaceFilesButton.tsx'
import { WorkspaceFilesDrawer } from './WorkspaceFilesDrawer.tsx'
import { en, zh, type WorkspaceFilesLocaleKey } from './locales.ts'

export type { WorkspaceFilesLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Workspace files panel copy. */
    'workspace-files': WorkspaceFilesLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'workspace-files'

/** Required services (cordis fiber inject): the slot registry, the wire-facing workspace service, and locale. */
export const inject = ['slots', 'workspaces', 'locale']

/**
 * Client plugin body: register the panel's dictionaries, create the shared
 * open-state controller, and fill the two seats — the sidebar footer action
 * and the shell-overlay drawer — through `slots.inject()` so the entries
 * activate whenever their declarations land.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workspace-files: dictionaries')

  const controller = new WorkspaceFilesPanelController()
  const injected = () => ({ controller, workspaces: ctx.workspaces })

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'workspace-files',
    order: 0,
    locale: NS,
    inject: injected,
  }, WorkspaceFilesButton))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'workspace-files-drawer',
    order: 10,
    locale: NS,
    inject: injected,
  }, WorkspaceFilesDrawer))
}
