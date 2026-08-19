/**
 * ctx.desktopShell (ADR-5): the native window, tray, and lifecycle as an
 * ordinary Host plugin over the loopback carrier — the same composition path
 * as any third-party plugin. The Electron bootstrap stays minimal (boot +
 * pre-boot update apply); everything the operator touches lives here, so a
 * future TUI or remote shell can replace or supplement it without forking
 * the shell.
 *
 * Window: sandboxed, same-origin-locked (ADR-3). Close hides to the tray
 * (the Host keeps serving sessions); quit runs through the shell's orderly
 * teardown. The tray drives ctx.desktopUpdates for manual checks.
 */
import { Service } from '@deepseek-ai/cordis'
import { app, BrowserWindow, Tray, Menu, nativeImage, shell } from 'electron'

/** 16x16 brand dot (single source: build pipeline replaces at packaging). */
const TRAY_ICON_B64
  = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAABLSURBVDhPzY4xDgAgCAN5nL/xj35NN4cDDU0YaHITvQazlhlz7RfsulCIoHPD4g+6khyO8JihboCHLHUf9BhQR+jesBhBx4WCJKs5TUJhqIM6esgAAAAASUVORK5CYII='

/** Module-level plugin facts — the canonical form the Loader reads. */
export const inject = ['webServer', 'desktopUpdates']

export default class DesktopShell extends Service {
  /** @param {import('@deepseek-ai/cordis').Context} ctx */
  constructor(ctx) {
    super(ctx, 'desktopShell')
    const origin = `http://${ctx.webServer.host}:${ctx.webServer.port}`
    this.quitting = false
    this.onBeforeQuit = () => { this.quitting = true }
    app.on('before-quit', this.onBeforeQuit)

    this.win = new BrowserWindow({
      width: 1280,
      height: 820,
      title: 'DSH Desktop Pro',
      autoHideMenuBar: true,
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    })
    this.win.once('ready-to-show', () => this.win.show())
    this.win.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== origin) {
        event.preventDefault()
        void shell.openExternal(url)
      }
    })
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      if (new URL(url).origin !== origin) void shell.openExternal(url)
      return { action: 'deny' }
    })
    this.win.on('close', (event) => {
      if (!this.quitting) {
        event.preventDefault()
        this.win.hide()
      }
    })

    this.tray = new Tray(nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_B64, 'base64')))
    this.tray.setToolTip('DSH Desktop Pro')
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => this.focus() },
      { label: '检查更新', click: () => void ctx.desktopUpdates?.checkNow({ silent: false }) },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]))
    this.tray.on('double-click', () => this.focus())

    this.win.loadURL(origin).catch((err) => console.error(`[pro] desktopShell: load failed: ${err.message}`))

    ctx.on('dispose', () => this.teardown())
    console.log(`[pro] desktopShell: window + tray up (${origin})`)
  }

  /** Bring the window back from hide/minimize. */
  focus() {
    if (this.win.isDestroyed()) return
    if (this.win.isMinimized()) this.win.restore()
    this.win.show()
    this.win.focus()
  }

  teardown() {
    app.removeListener('before-quit', this.onBeforeQuit)
    this.quitting = true
    if (this.tray !== undefined && !this.tray.isDestroyed()) this.tray.destroy()
    if (this.win !== undefined && !this.win.isDestroyed()) this.win.destroy()
  }
}
