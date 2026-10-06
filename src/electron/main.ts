import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, screen, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir, loadConfig, saveConfig } from '../core/config';
import { Monitor } from '../core/monitor';
import { startServer, type ServerHandle } from '../server/server';
import type { Snapshot } from '../shared/types';

declare const __APP_VERSION__: string;

if (process.platform === 'linux') {
  // transparent pet window on X11 compositors
  app.commandLine.appendSwitch('enable-transparent-visuals');
  // a plain 2D UI doesn't need the GPU; without this the sandboxed GPU process probes the Mesa
  // drivers it isn't allowed to open and logs "MESA-LOADER: failed to open …" on every start.
  // Software compositing is also what transparent windows on Linux are most reliable with.
  app.disableHardwareAcceleration();
}

// assets are unpacked from the asar so OS-level consumers (libnotify, tray) can read them
const assets = path.join(__dirname, '..', '..', 'assets').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
let mainWin: BrowserWindow | null = null;
let petWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let baseUrl = '';
let monitor: Monitor;
let server: ServerHandle | undefined;

// a custom VIBEPORTAL_HOME is a separate profile: give it its own Electron data dir
// (and therefore its own single-instance lock)
if (process.env.VIBEPORTAL_HOME) app.setPath('userData', path.join(process.env.VIBEPORTAL_HOME, 'electron'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showDashboard());
  app.whenReady().then(boot);
}

async function boot() {
  const cfg = loadConfig();
  monitor = new Monitor(cfg);
  const uiDir = path.join(__dirname, '..', 'ui');
  server = await startServer({ monitor, uiDir, port: cfg.port, mode: 'desktop', version: __APP_VERSION__, onSettingsChanged: applySettings });
  baseUrl = server.url;
  monitor.start();
  monitor.on('notice', (n) => {
    if (!monitor.config.notifications || !Notification.isSupported()) return;
    const note = new Notification({ title: n.title, body: n.body, icon: path.join(assets, 'icon.png'), silent: n.level === 'info' });
    note.on('click', showDashboard);
    note.show();
  });
  monitor.on('snapshot', (s: Snapshot) => {
    const q = s.providers
      .filter((p) => p.quotas.length)
      .map((p) => `${p.name} ${Math.round(Math.max(...p.quotas.map((x) => x.percent)))}%`)
      .join(' · ');
    const busy = s.tasks.filter((t) => t.state === 'running').length;
    tray?.setToolTip(`VibePortal — ${q || 'no quota data'}${busy ? ` — ${busy} running` : ''}`);
  });

  createTray();
  showDashboard();
  // Linux compositors need a beat before a transparent window is created
  setTimeout(applySettings, process.platform === 'linux' ? 400 : 0);

  ipcMain.on('open-dashboard', showDashboard);
  ipcMain.on('pet:hide', () => setPetEnabled(false));
  ipcMain.handle('pet:get-pos', () => petWin?.getPosition() ?? [0, 0]);
  ipcMain.on('pet:set-pos', (_e, x: number, y: number) => {
    if (petWin && Number.isFinite(x) && Number.isFinite(y)) petWin.setPosition(Math.round(x), Math.round(y));
  });
  ipcMain.on('pet:drag-end', () => savePetPos());
  // clones come and go and bubbles expand: fit the window to the content, keeping the
  // bottom-right corner where the user put it, and stay on screen
  ipcMain.on('pet:resize', (_e, width: number, height: number) => {
    if (!petWin || !Number.isFinite(width) || !Number.isFinite(height)) return;
    const b = petWin.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const w = Math.round(Math.min(area.width, Math.max(200, width)));
    const h = Math.round(Math.min(area.height, Math.max(120, height)));
    if (w === b.width && h === b.height) return;
    let x = b.x + b.width - w;
    let y = b.y + b.height - h;
    x = Math.max(area.x, Math.min(x, area.x + area.width - w));
    y = Math.max(area.y, Math.min(y, area.y + area.height - h));
    petWin.setBounds({ x, y, width: w, height: h });
  });
  ipcMain.on('pet:menu', () => {
    Menu.buildFromTemplate([
      { label: 'Open dashboard', click: showDashboard },
      { label: 'Refresh now', click: () => void monitor.refresh() },
      { type: 'separator' },
      { label: 'Hide pet', click: () => setPetEnabled(false) },
      { label: 'Quit VibePortal', click: quit },
    ]).popup({ window: petWin ?? undefined });
  });
}

function url(hash = '') {
  return `${baseUrl}/?token=${encodeURIComponent(monitor.config.apiToken)}${hash}`;
}

function showDashboard() {
  if (!baseUrl) return;
  if (mainWin && !mainWin.isDestroyed()) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
    return;
  }
  mainWin = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 380,
    minHeight: 500,
    title: 'VibePortal',
    icon: path.join(assets, 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#101012',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  mainWin.loadURL(url());
  // the dashboard never navigates away from the local server; send other links to the browser
  mainWin.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(baseUrl)) {
      e.preventDefault();
      if (/^https?:/.test(target)) void shell.openExternal(target);
    }
  });
  mainWin.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWin.on('close', (e) => {
    // closing the window keeps the app (tray + pet) alive
    if (!quitting) {
      e.preventDefault();
      mainWin?.hide();
    }
  });
}

function createPet() {
  const { size } = monitor.config.pet;
  const width = Math.round(size * 2.4);
  const height = Math.round(size * 1.7);
  const pos = loadPetPos(width, height);
  petWin = new BrowserWindow({
    width,
    height,
    x: pos.x,
    y: pos.y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    // focusable so instructions can be typed into a pet; shown inactive so it never steals focus
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  petWin.setAlwaysOnTop(true, 'floating');
  petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWin.loadURL(url('#/pet'));
  petWin.once('ready-to-show', () => petWin?.showInactive());
  petWin.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  petWin.on('closed', () => (petWin = null));
}

function applySettings() {
  const { pet } = monitor.config;
  if (pet.enabled) {
    // size changes are handled by the renderer, which refits the window ('pet:resize')
    if (!petWin) createPet();
  } else if (petWin) {
    petWin.close();
    petWin = null;
  }
  setLaunchAtLogin(monitor.config.launchAtLogin);
  rebuildTrayMenu();
}

function setPetEnabled(enabled: boolean) {
  const cfg = { ...monitor.config, pet: { ...monitor.config.pet, enabled } };
  saveConfig(cfg);
  monitor.setConfig(cfg);
  applySettings();
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(assets, process.platform === 'win32' ? 'tray.ico' : 'tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createFromPath(path.join(assets, 'icon.png')).resize({ width: 22, height: 22 }) : img);
  tray.setToolTip('VibePortal');
  tray.on('click', showDashboard);
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open dashboard', click: showDashboard },
      { label: 'Desktop pet', type: 'checkbox', checked: monitor.config.pet.enabled, click: (i) => setPetEnabled(i.checked) },
      { label: 'Refresh now', click: () => void monitor.refresh() },
      { label: 'Open in browser', click: () => void shell.openExternal(url()) },
      { type: 'separator' },
      { label: 'Quit', click: quit },
    ]),
  );
}

function quit() {
  quitting = true;
  app.quit();
}

app.on('before-quit', () => {
  quitting = true;
  monitor?.stop();
  server?.close();
});
app.on('window-all-closed', () => {
  // stay in the tray
});

// ── pet position persistence ────────────────────────────────────────────────
const posFile = () => path.join(dataDir(), 'pet-position.json');

function loadPetPos(w: number, h: number) {
  const area = screen.getPrimaryDisplay().workArea;
  const fallback = { x: area.x + area.width - w - 24, y: area.y + area.height - h - 24 };
  try {
    const p = JSON.parse(fs.readFileSync(posFile(), 'utf8'));
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return p.x >= a.x - w / 2 && p.x <= a.x + a.width - w / 2 && p.y >= a.y - h / 2 && p.y <= a.y + a.height - h / 2;
    });
    return visible ? { x: p.x, y: p.y } : fallback;
  } catch {
    return fallback;
  }
}

function savePetPos() {
  if (!petWin) return;
  const [x, y] = petWin.getPosition();
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(posFile(), JSON.stringify({ x, y }));
  } catch {
    /* non-fatal */
  }
}

// ── launch at login ─────────────────────────────────────────────────────────
function setLaunchAtLogin(enabled: boolean) {
  if (!app.isPackaged) return; // don't register the dev electron binary
  if (process.platform === 'linux') {
    const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart');
    const file = path.join(dir, 'vibeportal.desktop');
    if (!enabled) {
      fs.rmSync(file, { force: true });
      return;
    }
    const exec = process.env.APPIMAGE || process.execPath;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      file,
      `[Desktop Entry]\nType=Application\nName=VibePortal\nExec="${exec}"\nIcon=vibeportal\nX-GNOME-Autostart-enabled=true\nComment=Claude & ChatGPT usage monitor\n`,
    );
  } else {
    app.setLoginItemSettings({ openAtLogin: enabled });
  }
}
