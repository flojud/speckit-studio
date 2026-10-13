import { app, shell, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { failStaleRuns, getSetting, openDb, upsertAgent } from './db'
import { closeAllRuns } from './runs'
import { addToolPaths, adoptShellPath } from './env'
import { registerIpc } from './ipc'
import icon from '../../resources/icon.png?asset'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#0d0e10',
    titleBarStyle: 'hiddenInset',
    icon, // Windows/Linux window icon; macOS uses the bundle's .icns
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true }
  })
  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  // Unpackaged (npm run dev/start) the Dock would show Electron's icon.
  if (!app.isPackaged) app.dock?.setIcon(icon)
  await adoptShellPath()
  openDb(join(app.getPath('userData'), 'studio.db'))
  addToolPaths(getSetting('toolPaths', {}))
  failStaleRuns()
  // Deterministic fake agent for UI development; Electron runs it as plain Node.
  if (is.dev)
    upsertAgent({
      id: 'fake',
      name: 'Fake agent (dev)',
      command: process.execPath,
      args: [join(app.getAppPath(), 'tests/fake-agent.mjs')],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
  registerIpc()
  createWindow()
  // Without a `publish` target in electron-builder.yml there is no app-update.yml and this is a silent no-op.
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})

app.on('before-quit', closeAllRuns)
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit())
