// dsh-desktop main process.
// Spawns the dsh host (local 127.0.0.1 web server), waits for it to come up,
// then presents the dsh Web UI in a native Electron window. Closing the window
// tears the host process down.

const { app, BrowserWindow, dialog } = require('electron')
const { spawn } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const { applyStagedUpdate, checkForUpdate } = require('./updater.cjs')

const HOST_PORT = Number(process.env.DSH_DESKTOP_PORT || 3080)
const HOST_ADDR = '127.0.0.1'
const HOST_READY_TIMEOUT_MS = 60_000

let hostProcess = null
let mainWindow = null

/** Resolve the Node runtime used to launch the dsh host. */
function resolveNode() {
  if (app.isPackaged) {
    // Bundled alongside the app in resources/node/
    const exe = process.platform === 'win32' ? 'node.exe' : 'bin/node'
    const bundled = path.join(process.resourcesPath, 'node', exe)
    if (fs.existsSync(bundled)) return bundled
  }
  // Dev mode: the standalone Node used to build dsh (kept in repo .tools/)
  const glob = fs.readdirSync(path.join(__dirname, '.tools'), {
    withFileTypes: true,
  })
  for (const entry of glob) {
    if (!entry.isDirectory() || !entry.name.startsWith('node-v')) continue
    const cand = path.join(__dirname, '.tools', entry.name, 'node.exe')
    if (fs.existsSync(cand)) return cand
  }
  return null
}

/** Resolve the dsh CLI entry to boot. */
function resolveHostCli() {
  if (app.isPackaged) {
    // The runtime is installed flat (npm), so the CLI lives under node_modules.
    return path.join(process.resourcesPath, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  }
  return path.join(__dirname, '..', 'apps', 'cli', 'lib', 'bin.js')
}

/** Poll until the host answers on 127.0.0.1:port. */
function waitForHost(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get({ host: HOST_ADDR, port, timeout: 1_000 }, (res) => {
        res.destroy()
        resolve()
      })
      req.on('error', () => {
        req.destroy()
        if (Date.now() > deadline) reject(new Error(`dsh host did not start on port ${port}`))
        else setTimeout(check, 500)
      })
      req.on('timeout', () => req.destroy())
    }
    check()
  })
}

function startHost() {
  const node = resolveNode()
  if (!node) {
    dialog.showErrorBox('dsh-desktop', '未找到 Node 运行时，无法启动 dsh 宿主。')
    app.exit(1)
    return null
  }
  const cli = resolveHostCli()
  const child = spawn(node, [cli, 'web'], {
    cwd: app.isPackaged ? path.join(process.resourcesPath, 'dsh') : path.join(__dirname, '..'),
    env: { ...process.env, DSH_DESKTOP: '1' },
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      // Host died unexpectedly. If the window is still open, let the user know.
      if (mainWindow && !mainWindow.isDestroyed()) {
        dialog.showErrorBox(
          'dsh 宿主已退出',
          `dsh 宿主进程异常退出（code=${code}, signal=${signal}）。请重新启动应用。`,
        )
      }
    }
    hostProcess = null
  })
  return child
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'DeepSeek Harness',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  win.loadURL(`http://${HOST_ADDR}:${HOST_PORT}`)
  win.on('closed', () => {
    mainWindow = null
    if (hostProcess && !hostProcess.killed) hostProcess.kill()
  })
  return win
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  // Apply any update a previous session downloaded (host is not running yet).
  applyStagedUpdate(userData)

  hostProcess = startHost()
  if (!hostProcess) return
  try {
    await waitForHost(HOST_PORT, HOST_READY_TIMEOUT_MS)
  } catch (err) {
    dialog.showErrorBox('dsh-desktop', err.message)
    app.exit(1)
    return
  }
  mainWindow = createWindow()

  // Non-blocking update check in the background.
  checkForUpdate(userData).then((version) => {
    if (!version || !mainWindow || mainWindow.isDestroyed()) return
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'info',
      title: '发现新版本',
      message: `已下载新版本运行时（${version}）`,
      detail: '重启后生效。要立即重启吗？',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice === 0) {
      app.relaunch()
      app.exit(0)
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (hostProcess && !hostProcess.killed) hostProcess.kill()
})

app.on('activate', () => {
  // macOS: re-create the window when the dock icon is clicked.
  if (BrowserWindow.getAllWindows().length === 0 && hostProcess) {
    mainWindow = createWindow()
  }
})
