/**
 * Electron-backed `native` directory picker for the in-process Host.
 *
 * The upstream native backend opens the Win32 IFileOpenDialog in a child
 * process spawned from `process.execPath` — inside Electron that exe is
 * electron.exe, so the worker dies instantly. This backend implements the
 * same `ctx.directoryPicker` capability with Electron's own
 * `dialog.showOpenDialog`, entirely inside the Electron main process.
 *
 * Verified: the engine's plugin loader resolves 'electron' to the real
 * main-process bindings (Electron special-cases the specifier), so this
 * plugin imports them directly — no shell bridge. No `#private` fields:
 * Cordis service proxies invoke methods with the proxy as receiver, and
 * private-field brand checks then throw.
 */
import { dialog, BrowserWindow } from 'electron'
import { DirectoryPicker } from '@deepseek-ai/dsh-host-directory-picker'

/** The Electron native interaction capability (stable object per service life). */
export default class ElectronDirectoryPicker extends DirectoryPicker {
  /** @param {import('@deepseek-ai/cordis').Context} ctx */
  constructor(ctx) {
    super(ctx)
    this.electronCapability = {
      kind: 'native',
      /**
       * Open the OS directory chooser.
       * @param {AbortSignal} signal - caller lifetime.
       * @returns {Promise<string | null>} chosen absolute path, or null on cancel.
       */
      pick: (signal) => {
        if (typeof dialog?.showOpenDialog !== 'function') {
          return Promise.reject(new Error(
            "picker-electron: Electron bindings unavailable (imported 'electron' resolved to the npm stub?) — "
            + 'this plugin must run inside the DSH Desktop Pro main process',
          ))
        }
        return pickViaElectron(signal)
      },
    }
  }

  capability() {
    return this.electronCapability
  }
}

/** Electron dialog, window-modal to the first live window. */
async function pickViaElectron(signal) {
  const parent = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? undefined
  const chosen = await dialog.showOpenDialog(parent, {
    title: '选择工作区目录',
    properties: ['openDirectory', 'dontAddToRecent'],
  })
  if (signal?.aborted) return null
  return chosen.canceled || chosen.filePaths.length === 0 ? null : chosen.filePaths[0]
}
