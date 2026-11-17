import { app, BrowserWindow, dialog, shell } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBoardCutServer, resolveDatabasePath } from './server.mjs';
import { registerZoomShortcuts } from './electron-zoom.mjs';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
let mainWindow = null;
let localServer = null;
let quitting = false;

function executableDirectory() {
  return app.isPackaged ? dirname(process.execPath) : projectRoot;
}

async function stopLocalServer() {
  if (!localServer) return;
  const server = localServer;
  localServer = null;
  await server.close();
}

async function createMainWindow() {
  const databasePath = resolveDatabasePath(executableDirectory());
  localServer = createBoardCutServer({
    staticRoot: projectRoot,
    databasePath,
    port: 0,
  });
  const { url } = await localServer.start();

  mainWindow = new BrowserWindow({
    title: '板优排',
    width: 1440,
    height: 920,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    icon: join(projectRoot, 'assets', 'app-icon.png'),
    backgroundColor: '#f3f3ef',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (/^https?:\/\//i.test(targetUrl)) shell.openExternal(targetUrl);
    return { action: 'deny' };
  });
  registerZoomShortcuts(mainWindow.webContents);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(url);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(createMainWindow).catch(async (error) => {
    await stopLocalServer().catch(() => {});
    dialog.showErrorBox('板优排启动失败', `${error.message}\n\n数据库位置：${join(executableDirectory(), 'data')}`);
    app.quit();
  });

  app.on('window-all-closed', async () => {
    if (quitting) return;
    quitting = true;
    await stopLocalServer().catch(() => {});
    app.quit();
  });
}
