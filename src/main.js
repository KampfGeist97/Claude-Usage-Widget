'use strict';

const { app, BrowserWindow, Menu, Tray, ipcMain, screen, session, shell, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeUsage } = require('./usage-parser');

const VERSION = '3.0.0';
const PARTITION = 'persist:claude-usage';
const CLAUDE_URL = 'https://claude.ai/';
const WIDGET_WIDTH = 390;
const WIDGET_HEIGHT = 535;
const MARGIN = 12;

let widgetWindow = null;
let claudeWindow = null;
let loginWindow = null;
let tray = null;
let quitting = false;
let pollTimer = null;
let cachedSnapshot = null;
let cachedError = null;
let fetchInFlight = null;

const DEFAULT_SETTINGS = {
  rememberPosition: true,
  hideOnFocusLoss: false,
  refreshSeconds: 60,
  x: null,
  y: null
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

let settings = { ...DEFAULT_SETTINGS };

function saveSettings() {
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8');
}

function clampPointToDisplay(x, y, width = WIDGET_WIDTH, height = WIDGET_HEIGHT) {
  const displays = screen.getAllDisplays();
  let display = displays.find(d => {
    const a = d.workArea;
    return x >= a.x && x < a.x + a.width && y >= a.y && y < a.y + a.height;
  });
  if (!display) display = screen.getPrimaryDisplay();
  const a = display.workArea;
  return {
    x: Math.min(Math.max(x, a.x), Math.max(a.x, a.x + a.width - width)),
    y: Math.min(Math.max(y, a.y), Math.max(a.y, a.y + a.height - height))
  };
}

function bottomRightPosition() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor) || screen.getPrimaryDisplay();
  const a = display.workArea;
  return {
    x: a.x + a.width - WIDGET_WIDTH - MARGIN,
    y: a.y + a.height - WIDGET_HEIGHT - MARGIN
  };
}

function positionWidgetForShow() {
  if (!widgetWindow) return;
  if (settings.rememberPosition && Number.isFinite(settings.x) && Number.isFinite(settings.y)) {
    const p = clampPointToDisplay(settings.x, settings.y);
    widgetWindow.setPosition(Math.round(p.x), Math.round(p.y), false);
  } else {
    const p = bottomRightPosition();
    widgetWindow.setPosition(Math.round(p.x), Math.round(p.y), false);
  }
}

function showWidget() {
  if (!widgetWindow) return;
  positionWidgetForShow();
  widgetWindow.show();
  widgetWindow.focus();
  if (!cachedSnapshot) void refreshUsage({ force: true, reason: 'show' });
}

function toggleWidget() {
  if (!widgetWindow) return;
  if (widgetWindow.isVisible()) widgetWindow.hide();
  else showWidget();
}

function createWidgetWindow() {
  widgetWindow = new BrowserWindow({
    title: 'Claude Usage',
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
    minWidth: 340,
    minHeight: 420,
    maxWidth: 520,
    maxHeight: 760,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    shadow: true,
    backgroundColor: '#00000000',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  });

  widgetWindow.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));

  widgetWindow.on('close', event => {
    if (!quitting) {
      event.preventDefault();
      widgetWindow.hide();
    }
  });

  widgetWindow.on('moved', () => {
    if (!settings.rememberPosition || !widgetWindow) return;
    const [x, y] = widgetWindow.getPosition();
    settings.x = x;
    settings.y = y;
    saveSettings();
  });

  widgetWindow.on('blur', () => {
    if (settings.hideOnFocusLoss && widgetWindow?.isVisible()) widgetWindow.hide();
  });

  widgetWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function claudeSession() {
  return session.fromPartition(PARTITION, { cache: true });
}

function hardenRemoteContents(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    // OAuth/SSO providers can legitimately open a popup. Keep it inside a sandboxed Electron child.
    if (/^https:\/\//i.test(url)) return { action: 'allow' };
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!/^https:\/\//i.test(url)) event.preventDefault();
  });
}

function createClaudeWindow() {
  claudeWindow = new BrowserWindow({
    width: 1000,
    height: 760,
    show: false,
    skipTaskbar: true,
    title: 'Claude Session',
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  });
  hardenRemoteContents(claudeWindow);
  claudeWindow.loadURL(CLAUDE_URL).catch(() => {});
  claudeWindow.on('closed', () => { claudeWindow = null; });
}

function createLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.show();
    loginWindow.focus();
    return loginWindow;
  }

  loginWindow = new BrowserWindow({
    width: 1050,
    height: 800,
    minWidth: 760,
    minHeight: 600,
    show: false,
    title: 'Claude anmelden',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  });

  hardenRemoteContents(loginWindow);
  loginWindow.once('ready-to-show', () => loginWindow?.show());
  loginWindow.on('closed', () => { loginWindow = null; });
  loginWindow.webContents.on('did-finish-load', () => void detectLoginSuccess());
  loginWindow.webContents.on('did-navigate', () => void detectLoginSuccess());
  loginWindow.webContents.on('did-navigate-in-page', () => void detectLoginSuccess());
  loginWindow.loadURL(CLAUDE_URL).catch(err => {
    notifySession({ connected: false, error: `Claude-Anmeldeseite konnte nicht geladen werden: ${err.message}` });
  });
  return loginWindow;
}

async function ensureClaudeReady() {
  if (!claudeWindow || claudeWindow.isDestroyed()) createClaudeWindow();
  if (claudeWindow.webContents.isLoadingMainFrame()) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Claude-WebSession konnte nicht rechtzeitig geladen werden.')), 25000);
      claudeWindow.webContents.once('did-finish-load', () => { clearTimeout(timeout); resolve(); });
      claudeWindow.webContents.once('did-fail-load', (_e, code, desc, url, main) => {
        if (!main) return;
        clearTimeout(timeout);
        reject(new Error(`Claude-WebSession: ${desc} (${code}) ${url}`));
      });
    });
  }
  const current = claudeWindow.webContents.getURL();
  if (!current.startsWith('https://claude.ai')) {
    await claudeWindow.loadURL(CLAUDE_URL);
  }
}

const FETCH_USAGE_SCRIPT = `
(async () => {
  const safeText = async (response) => {
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { text, json };
  };

  try {
    const orgResponse = await fetch('/api/organizations', {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'accept': 'application/json' }
    });
    const orgBody = await safeText(orgResponse);
    if (!orgResponse.ok) {
      return { ok: false, phase: 'organizations', status: orgResponse.status, contentType: orgResponse.headers.get('content-type') || '', body: orgBody.text.slice(0, 800) };
    }

    const orgs = Array.isArray(orgBody.json)
      ? orgBody.json
      : Array.isArray(orgBody.json?.organizations)
        ? orgBody.json.organizations
        : [];
    if (!orgs.length) return { ok: false, phase: 'organizations', status: 200, body: 'Keine Claude-Organisation im Account gefunden.' };

    const cookieMatch = document.cookie.match(/(?:^|;\\s*)lastActiveOrg=([^;]+)/);
    const preferred = cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
    const orgIdOf = o => String(o?.uuid ?? o?.id ?? o?.organization_id ?? '');
    const active = orgs.find(o => orgIdOf(o) === preferred) || orgs[0];
    const orgId = orgIdOf(active);
    if (!orgId) return { ok: false, phase: 'organizations', status: 200, body: 'Organisation ohne UUID/ID erhalten.' };

    const usageResponse = await fetch('/api/organizations/' + encodeURIComponent(orgId) + '/usage', {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'accept': 'application/json' }
    });
    const usageBody = await safeText(usageResponse);
    if (!usageResponse.ok) {
      return { ok: false, phase: 'usage', status: usageResponse.status, contentType: usageResponse.headers.get('content-type') || '', body: usageBody.text.slice(0, 800), orgId };
    }
    if (!usageBody.json) return { ok: false, phase: 'usage', status: 200, body: 'Usage-Antwort war kein JSON.', orgId };
    return { ok: true, orgId, usage: usageBody.json };
  } catch (error) {
    return { ok: false, phase: 'fetch', status: 0, body: String(error?.stack || error?.message || error) };
  }
})()
`;

async function fetchUsageFromClaudeWindow() {
  await ensureClaudeReady();
  const result = await claudeWindow.webContents.executeJavaScript(FETCH_USAGE_SCRIPT, true);
  if (result?.ok) return result;

  const status = Number(result?.status || 0);
  const body = String(result?.body || 'Unbekannter Fehler');
  const htmlChallenge = /just a moment|challenge-platform|cf-browser-verification|_cf_chl_opt/i.test(body);
  const authRequired = status === 401 || (status === 403 && !htmlChallenge) || /sign.?in|login|unauthorized/i.test(body);
  const error = new Error(
    `${result?.phase || 'Claude'}: ${status ? `HTTP ${status}` : 'Netzwerk-/Browserfehler'} — ${body.replace(/\s+/g, ' ').slice(0, 500)}`
  );
  error.code = authRequired ? 'AUTH_REQUIRED' : (htmlChallenge ? 'CLOUDFLARE_CHALLENGE' : 'FETCH_FAILED');
  throw error;
}

async function refreshUsage({ force = false, reason = 'manual' } = {}) {
  if (fetchInFlight) return fetchInFlight;
  fetchInFlight = (async () => {
    try {
      const result = await fetchUsageFromClaudeWindow();
      cachedSnapshot = normalizeUsage(result.usage);
      cachedSnapshot.organization_id = result.orgId;
      cachedSnapshot.refresh_reason = reason;
      cachedError = null;
      notifyUsage({ ok: true, snapshot: cachedSnapshot });
      notifySession({ connected: true });
      return cachedSnapshot;
    } catch (err) {
      cachedError = { message: err.message, code: err.code || 'ERROR', at: new Date().toISOString() };
      notifyUsage({ ok: false, error: cachedError });
      if (err.code === 'AUTH_REQUIRED') notifySession({ connected: false, error: null });
      if (force) throw err;
      return null;
    } finally {
      fetchInFlight = null;
    }
  })();
  return fetchInFlight;
}

async function detectLoginSuccess() {
  if (!loginWindow || loginWindow.isDestroyed()) return false;
  const url = loginWindow.webContents.getURL();
  if (!url.startsWith('https://claude.ai')) return false;
  try {
    const result = await loginWindow.webContents.executeJavaScript(`
      (async () => {
        try {
          const r = await fetch('/api/organizations', { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' } });
          if (!r.ok) return false;
          const j = await r.json();
          return Array.isArray(j) ? j.length > 0 : Array.isArray(j?.organizations) && j.organizations.length > 0;
        } catch { return false; }
      })()
    `, true);
    if (!result) return false;
    loginWindow.hide();
    await claudeWindow?.loadURL(CLAUDE_URL).catch(() => {});
    notifySession({ connected: true });
    await refreshUsage({ force: false, reason: 'login' });
    return true;
  } catch {
    return false;
  }
}

function notifyUsage(payload) {
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.webContents.send('usage:updated', payload);
}

function notifySession(payload) {
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.webContents.send('session:changed', payload);
}

function startPoller() {
  if (pollTimer) clearInterval(pollTimer);
  const seconds = Math.max(60, Number(settings.refreshSeconds) || 60);
  pollTimer = setInterval(() => void refreshUsage({ force: false, reason: 'timer' }), seconds * 1000);
}

async function sessionStatus() {
  if (cachedSnapshot) return { connected: true, error: cachedError };
  try {
    await refreshUsage({ force: true, reason: 'status' });
    return { connected: true, error: null };
  } catch (err) {
    return { connected: err.code !== 'AUTH_REQUIRED' && err.code !== 'FETCH_FAILED' ? false : false, error: err.code === 'AUTH_REQUIRED' ? null : err.message };
  }
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.ico');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);
  tray.setToolTip(`Claude Usage Widget ${VERSION}`);
  tray.on('click', toggleWidget);
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const autostart = getAutostart();
  const menu = Menu.buildFromTemplate([
    { label: 'Dashboard anzeigen', click: showWidget },
    { label: 'Jetzt aktualisieren', click: () => void refreshUsage({ force: false, reason: 'tray' }) },
    { type: 'separator' },
    { label: 'Mit Windows starten', type: 'checkbox', checked: autostart, click: item => setAutostart(item.checked) },
    { label: 'Claude neu anmelden', click: () => createLoginWindow() },
    { type: 'separator' },
    { label: 'Beenden', click: quitApp }
  ]);
  tray.setContextMenu(menu);
}

function getAutostart() {
  if (!app.isPackaged) return false;
  return app.getLoginItemSettings().openAtLogin;
}

function setAutostart(enabled) {
  if (!app.isPackaged) return false;
  app.setLoginItemSettings({
    openAtLogin: Boolean(enabled),
    path: process.execPath,
    args: ['--hidden']
  });
  rebuildTrayMenu();
  return getAutostart();
}

async function clearClaudeSession() {
  const s = claudeSession();
  await s.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] });
  await s.clearCache();
  cachedSnapshot = null;
  cachedError = null;
  await claudeWindow?.loadURL(CLAUDE_URL).catch(() => {});
  notifySession({ connected: false, error: null });
}

function quitApp() {
  quitting = true;
  app.quit();
}

function registerIpc() {
  ipcMain.handle('window:hide', () => widgetWindow?.hide());
  ipcMain.handle('app:quit', () => quitApp());

  ipcMain.handle('session:status', () => sessionStatus());
  ipcMain.handle('session:login', () => {
    createLoginWindow();
    return { opened: true };
  });
  ipcMain.handle('session:logout', async () => {
    await clearClaudeSession();
    return { connected: false };
  });
  ipcMain.handle('session:open-data-folder', async () => {
    const dir = path.join(app.getPath('userData'), 'Partitions');
    await shell.openPath(dir);
    return true;
  });

  ipcMain.handle('usage:get', async () => {
    if (cachedSnapshot) return cachedSnapshot;
    return refreshUsage({ force: true, reason: 'get' });
  });
  ipcMain.handle('usage:refresh', () => refreshUsage({ force: true, reason: 'manual' }));

  ipcMain.handle('settings:get', () => ({ ...settings }));
  ipcMain.handle('settings:update', (_event, patch) => {
    if (Object.prototype.hasOwnProperty.call(patch, 'rememberPosition')) settings.rememberPosition = Boolean(patch.rememberPosition);
    if (Object.prototype.hasOwnProperty.call(patch, 'hideOnFocusLoss')) settings.hideOnFocusLoss = Boolean(patch.hideOnFocusLoss);
    if (Object.prototype.hasOwnProperty.call(patch, 'refreshSeconds')) settings.refreshSeconds = Math.max(60, Number(patch.refreshSeconds) || 60);
    saveSettings();
    startPoller();
    return { ...settings };
  });

  ipcMain.handle('autostart:get', () => getAutostart());
  ipcMain.handle('autostart:set', (_event, enabled) => setAutostart(Boolean(enabled)));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWidget());

  app.whenReady().then(async () => {
    app.setAppUserModelId('local.claude.usage.widget');
    settings = loadSettings();
    registerIpc();
    createWidgetWindow();
    createClaudeWindow();
    createTray();
    startPoller();

    screen.on('display-removed', () => {
      if (!widgetWindow) return;
      const [x, y] = widgetWindow.getPosition();
      const p = clampPointToDisplay(x, y, ...widgetWindow.getSize());
      widgetWindow.setPosition(p.x, p.y, false);
    });

    const startHidden = process.argv.includes('--hidden');
    if (!startHidden) showWidget();
    setTimeout(() => void refreshUsage({ force: false, reason: 'startup' }), 1500);
  });
}

app.on('window-all-closed', event => {
  // Tray application: keep main process alive on Windows.
  if (!quitting) event.preventDefault?.();
});

app.on('before-quit', () => { quitting = true; });
