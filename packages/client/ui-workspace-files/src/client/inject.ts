/**
 * The injected business face every panel registration receives: the shared
 * open-state controller plus the wire-facing workspaces service (its three
 * workspace-files methods). No hooks compartment — plain members.
 */
import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceFilesPanelController } from './controller.ts'

/** The panel's injected share (passed verbatim into registrant props). */
export interface WorkspaceFilesInjected {
  /** Shared drawer open-state (toggle from the entry button, close from the drawer). */
  controller: WorkspaceFilesPanelController
  /** The wire-facing workspace service (listing, text reads, image URLs). */
  workspaces: IWorkspaces
}

/** Image extensions the preview offers (mirrors the Host serving allowlist). */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

/** True when a file entry's path names a previewable image. */
export function isImageEntry(path: string): boolean {
  const dot = path.lastIndexOf('.')
  return dot !== -1 && IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase())
}
