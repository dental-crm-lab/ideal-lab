const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// Built-in server address — the app opens straight to this site, no setup screen.
const DEFAULT_SERVER_URL = 'https://ideal-lab-production.up.railway.app';

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch (e) { return {}; }
}
function saveConfig(cfg) {
  try { fs.writeFileSync(configPath(), JSON.stringify(cfg)); } catch (e) { console.error(e); }
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    title: 'IDEAL Lab',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#F2F4F5',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Open external links (e.g. uploaded-file links opened in a new tab) in
  // the system browser instead of a second Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const cfg = loadConfig();
  mainWindow.loadURL(cfg.serverUrl || DEFAULT_SERVER_URL);

  const menu = Menu.buildFromTemplate([
    {
      label: 'IDEAL Lab',
      submenu: [
        {
          label: 'Сменить адрес сервера…',
          click: () => {
            saveConfig({});
            mainWindow.loadFile(path.join(__dirname, 'config.html'));
          }
        },
        { label: 'Обновить', accelerator: 'CmdOrCtrl+R', click: () => mainWindow.reload() },
        { type: 'separator' },
        { role: 'quit', label: 'Выход' }
      ]
    },
    {
      label: 'Правка',
      submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }]
    },
    {
      label: 'Вид',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }]
    }
  ]);
  Menu.setApplicationMenu(menu);
}

ipcMain.handle('save-server-url', (event, url) => {
  let clean = String(url || '').trim();
  if (clean && !/^https?:\/\//i.test(clean)) clean = 'https://' + clean;
  clean = clean.replace(/\/+$/, '');
  saveConfig({ serverUrl: clean });
  if (mainWindow) mainWindow.loadURL(clean);
  return clean;
});
ipcMain.handle('get-server-url', () => loadConfig().serverUrl || '');

app.whenReady().then(createWindow);

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
