/**
 * Shared open-state of the workspace files panel. The sidebar footer action
 * (the entry button) and the shell-overlay drawer register from one plugin
 * body, so a plain closure-scoped observable connects them — no ctx service,
 * no cross-package state seam. React binds through useSyncExternalStore.
 */

/** The panel's externally observable state. */
export interface WorkspaceFilesPanelState {
  /** Whether the drawer is shown. */
  open: boolean
}

/**
 * Minimal external store: identity-stable subscribe/getSnapshot, notify-on-
 * write. `Object.is` on the state object keeps useSyncExternalStore tear-free
 * (a new object per write, never in-place mutation).
 */
export class WorkspaceFilesPanelController {
  private listeners = new Set<() => void>()
  private state: WorkspaceFilesPanelState = { open: false }

  /** @returns the current state (a fresh object per write, never mutated). */
  getSnapshot = (): WorkspaceFilesPanelState => this.state

  /**
   * Subscribe to state writes.
   * @param listener - called after every write.
   * @returns unsubscribe.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Flip the drawer between shown and hidden. */
  toggle = (): void => {
    this.write({ open: !this.state.open })
  }

  /** Hide the drawer. */
  close = (): void => {
    if (!this.state.open) return
    this.write({ open: false })
  }

  private write(patch: Partial<WorkspaceFilesPanelState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of [...this.listeners]) listener()
  }
}
