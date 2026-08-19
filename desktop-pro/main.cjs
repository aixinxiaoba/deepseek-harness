/**
 * DSH Desktop Pro — shell (post-P3: minimal bootstrap).
 *
 * Everything operator-facing lives in Host plugins composed by the overlay
 * (desktop-shell: window/tray; desktop-updates: ctx.desktopUpdates;
 * picker-electron: native folder dialog). This file only does what CANNOT
 * run inside the tree: single-instance lock, logging, renderer permission
 * lockdown, PRE-BOOT staged-update apply, the in-process engine boot, the
 * first-run onboarding window, and orderly teardown.
 */
const { app, BrowserWindow, dialog, ipcMain, session } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const updater = require('./updater.cjs')
const log = require('./log.cjs')

// Root fix for the packaged HMR crash: the engine's HMR resolves the process
// entry from argv[1] (CLI convention — `node entry.js`). A packaged Electron
// app passes no script argument; argv[1] conventionally names the entry
// script, and this shell IS that script.
if (process.argv[1] === undefined) process.argv[1] = __filename

/**
 * Physical application root. In a packaged build __dirname sits inside the
 * asar archive; junction targets and the updater's rename/apply need REAL
 * paths, so everything that touches the filesystem tree resolves through the
 * unpacked mirror instead.
 */
const PHYSICAL_ROOT = __dirname.includes('app.asar')
  ? __dirname.split('app.asar').join('app.asar.unpacked')
  : __dirname

/** Engine CLI package inside the npm-installed dependency tree. */
const ENGINE_DIR = path.join(PHYSICAL_ROOT, 'node_modules', '@deepseek-ai', 'dsh')

let engineCtx = null

/**
 * The Loader resolves bare plugin names from the PROFILE's module fallback
 * (`$DSH_HOME/profiles/node_modules`). The engine's heal junctions cover only
 * `@deepseek-ai/*`; link our shell-owned plugins into the same fallback.
 */
function ensureShellPluginsResolvable() {
  const fallbackDir = path.join(os.homedir(), '.dsh', 'profiles', 'node_modules')
  fs.mkdirSync(fallbackDir, { recursive: true })
  for (const name of ['desktop-shell', 'desktop-updates', 'picker-electron']) {
    const target = path.join(PHYSICAL_ROOT, 'node_modules', name)
    const link = path.join(fallbackDir, name)
    if (fs.existsSync(link)) continue
    if (!fs.existsSync(target)) throw new Error(`shell plugin missing: ${target}`)
    fs.symlinkSync(target, link, 'junction')
    console.log(`[pro] linked shell plugin ${name} into the profile module fallback`)
  }
}

// --- single instance ---------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => engineCtx?.get('desktopShell')?.focus())

  app.whenReady().then(async () => {
    log.init(app.getPath('userData'))

    // The carrier is a loopback web app — deny every renderer permission.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      console.warn(`[pro] denied renderer permission request: ${permission}`)
      callback(false)
    })

    // Design §4.2: apply any staged update while the Host is NOT running.
    const applied = updater.applyStaged({ engineDir: PHYSICAL_ROOT, userData: app.getPath('userData') })
    if (applied !== null) {
      dialog.showMessageBoxSync({
        type: 'info',
        title: 'DSH Desktop Pro',
        message: `已更新到运行时 ${applied.runtimeVersion}`,
        detail: `更新序列 ${applied.sequence}（${applied.apply.length} 个包）已生效。`,
      })
    }

    await bootEngine().catch(fatal)
    maybeShowOnboarding()
  })
}

// --- engine boot ---------------------------------------------------------------
/**
 * Boot the dsh Host Cordis root in-process against the `web` profile. The
 * overlay composes the whole desktop: ephemeral loopback port, watch-only HMR
 * as a row (so profile-boot's runtime fallback never runs — it dies in
 * packaged Electron), the Electron directory picker, and the desktop
 * shell/updates plugins.
 */
async function bootEngine() {
  const libDir = path.join(ENGINE_DIR, 'lib')
  // The bundler emits a hashed profile-boot chunk plus re-export shims; pick
  // whichever module actually exports runProfile, robust across versions.
  let runProfile = null
  for (const file of fs.readdirSync(libDir).filter((f) => /^profile-boot-.*\.js$/.test(f))) {
    const mod = await import(pathToFileURL(path.join(libDir, file)).href)
    if (typeof mod.runProfile === 'function') {
      runProfile = mod.runProfile
      break
    }
  }
  if (runProfile === null) {
    throw new Error(`no module exporting runProfile under ${libDir} — engine layout changed?`)
  }
  const { loadLayeredEnv } = await import('@deepseek-ai/dsh-app-boot')
  ensureShellPluginsResolvable()

  const patchFile = path.join(app.getPath('userData'), 'dsh-desktop-pro.patch.yml')
  fs.mkdirSync(path.dirname(patchFile), { recursive: true })
  fs.writeFileSync(patchFile, [
    '# DSH Desktop Pro boot overlay (regenerated per launch)',
    '- id: webserver',
    '  config:',
    '    host: 127.0.0.1',
    '    port: 0',
    // Watch-only HMR as an ordinary ROW: profile-boot otherwise mounts it at
    // runtime through loader.create(), which dies in packaged Electron.
    '- id: hmr',
    '  disabled: false',
    '  config:',
    '    root: []',
    // Upstream native picker's Win32 worker spawns process.execPath —
    // electron.exe here — so compose the Electron-backed capability directly
    // with the upstream native CLIENT surface instead.
    '- id: directory-picker',
    '  disabled: true',
    '- insert:',
    '    - id: directory-picker-electron',
    '      name: picker-electron',
    '    - id: directory-picker-native-surface',
    "      name: '@deepseek-ai/dsh-client-ui-directory-picker-native'",
    // The desktop itself, as ordinary composition rows. Row-level inject is
    // what the Loader's service-access guard checks — the class's static
    // inject alone does not open access for config-row entries.
    '    - id: desktop-updates',
    '      name: desktop-updates',
    '      inject: [timer]',
    '    - id: desktop-shell',
    '      name: desktop-shell',
    '      inject: [webServer, desktopUpdates]',
    '',
  ].join('\n'))

  const { ctx } = await runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'web',
    patchFiles: [patchFile],
    args: [],
  })
  engineCtx = ctx

  const port = ctx.webServer?.port
  if (typeof port !== 'number' || port <= 0) {
    throw new Error(`webServer service did not report a listening port (got ${String(port)})`)
  }
  console.log(`[pro] host booted in-process, UI carrier at http://127.0.0.1:${port}`)
}

// --- first-run onboarding ---------------------------------------------------
/** Show the onboarding window once, before the operator has configured anything. */
function maybeShowOnboarding() {
  const userData = app.getPath('userData')
  const configFile = path.join(userData, 'update-config.json')
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(configFile, 'utf8')) } catch { /* first run */ }
  if (cfg.onboarded === true) return

  ipcMain.handle('dsh-pro:onboarding-save', (_event, choices) => {
    try {
      if (typeof choices?.apiKey === 'string' && choices.apiKey !== '') persistApiKey(choices.apiKey)
      if (typeof choices?.updateUrl === 'string' && choices.updateUrl !== '') {
        cfg = { ...cfg, url: choices.updateUrl }
      }
      cfg.onboarded = true
      fs.mkdirSync(userData, { recursive: true })
      fs.writeFileSync(configFile, `${JSON.stringify(cfg, null, 2)}\n`)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('dsh-pro:onboarding-finish', () => { onboardingWindow?.close() })

  const onboardingWindow = new BrowserWindow({
    width: 600,
    height: 520,
    title: 'DSH Desktop Pro · 首次设置',
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(PHYSICAL_ROOT, 'node_modules', 'onboarding', 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  })
  onboardingWindow.once('ready-to-show', () => onboardingWindow.show())
  onboardingWindow.on('closed', () => {
    ipcMain.removeHandler('dsh-pro:onboarding-save')
    ipcMain.removeHandler('dsh-pro:onboarding-finish')
    engineCtx?.get('desktopShell')?.focus()
  })
  onboardingWindow.loadFile(path.join(PHYSICAL_ROOT, 'node_modules', 'onboarding', 'index.html')).catch(fatal)
}

/**
 * Store the DeepSeek key in the engine's credentials file (same file the Web
 * UI settings write), preserving every other line.
 */
function persistApiKey(key) {
  const file = path.join(os.homedir(), '.dsh', '.credentials.yaml')
  const line = `DEEPSEEK_API_KEY: ${JSON.stringify(key)}`
  let lines = []
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/) } catch { /* new file */ }
  const at = lines.findIndex((l) => /^DEEPSEEK_API_KEY\s*:/.test(l))
  if (at >= 0) lines[at] = line
  else lines.push(line)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${lines.filter((l, i, arr) => l !== '' || i === arr.length - 1).join('\n')}\n`)
}

/** Report a startup failure and leave. */
function fatal(error) {
  const message = error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error)
  // Full cause chain: wrapper errors (loader updateError) hide the throw site.
  let cause = error?.cause
  let depth = 0
  let chain = ''
  while (cause !== undefined && cause !== null && depth < 8) {
    chain += `\n[cause ${depth}] ${cause.message ?? String(cause)}\n${cause.stack ?? ''}\n`
    if (Array.isArray(cause.errors)) {
      for (const e of cause.errors.slice(0, 8)) {
        chain += `  · ${e?.message ?? String(e)}\n${(e?.stack ?? '').split('\n').slice(1, 3).map((l) => `    ${l}`).join('\n')}\n`
      }
    }
    cause = cause.cause
    depth += 1
  }
  // AggregateError details (the loader's per-entry failures) never print otherwise.
  let aggregate = error
  let ai = 0
  let agg = ''
  while (aggregate?.errors !== undefined && ai < 4) {
    agg += `\n[aggregate ${ai}] ${aggregate.errors.length} error(s):\n`
    for (const e of aggregate.errors.slice(0, 6)) {
      agg += `  - ${e?.message ?? String(e)}\n${(e?.stack ?? '').split('\n').slice(1, 3).join('\n')}\n`
    }
    aggregate = aggregate.errors.find((e) => e?.errors !== undefined)
    ai += 1
  }
  console.error(`[pro] fatal: ${message}${chain}${agg}`)
  if (app.isReady()) dialog.showErrorBox('DSH Desktop Pro', `启动失败：\n${message}`)
  app.exit(1)
}

// --- lifecycle -------------------------------------------------------------
app.on('window-all-closed', () => { /* tray owns quitting */ })

app.on('before-quit', (event) => {
  if (engineCtx !== null) {
    event.preventDefault()
    const ctx = engineCtx
    engineCtx = null
    // Orderly Cordis teardown, bounded by five seconds, then exit regardless.
    const finish = () => app.exit(0)
    const deadline = setTimeout(finish, 5_000)
    deadline.unref()
    ctx.fiber.dispose().catch(() => undefined).finally(() => {
      clearTimeout(deadline)
      finish()
    })
  }
})

process.on('unhandledRejection', (reason) => {
  console.error(`[pro] unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`)
})
