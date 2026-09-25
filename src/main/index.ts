// beatmania.app Synchronizer — 진입점.
//
// 트레이에 상주한다. 창을 닫아도 꺼지지 않고 트레이로 숨는다. 끄려면 트레이 메뉴의
// "종료". Windows 로그인 때 창 없이(--hidden) 뜬다.
import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import { join } from 'path';

import { log, logDir, onLine, recent } from './log';
import * as settings from './settings';
import { Sync } from './sync';
import { installNow, startUpdater, UpdateStatus } from './updater';

const ASSETS = join(__dirname, '..', '..', 'assets');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let updateStatus: { status: UpdateStatus; version?: string } = { status: 'idle' };
const sync = new Sync();

if (!app.requestSingleInstanceLock()) {
  // 이미 떠 있다. 그쪽 창을 띄우게 하고 이쪽은 끈다.
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(boot);
}

function snapshot() {
  return {
    ...sync.state,
    update: updateStatus,
    launchAtLogin: settings.load().launchAtLogin,
    serverUrl: settings.load().serverUrl,
    log: recent(),
  };
}

function push(): void {
  win?.webContents.send('state', snapshot());
  refreshTray();
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 520,
    height: 640,
    show: false,
    resizable: true,
    autoHideMenuBar: true,
    title: 'beatmania.app Synchronizer',
    icon: join(ASSETS, 'tray.png'),
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();          // 닫기 = 트레이로 숨기기
    win?.hide();
  });
  // 창 안의 링크는 기본 브라우저로 연다.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWindow(): void {
  if (!win) createWindow();
  win!.show();
  win!.focus();
}

function trayLabel(): string {
  const s = sync.state;
  if (!s.tokenSet) return '토큰을 넣어 주세요';
  if (s.tokenInvalid) return '토큰이 올바르지 않습니다';
  if (s.error) return '문제가 있습니다';
  if (s.game === 'running') return s.pending ? '게임 중 — 보낼 기록 있음' : '게임 중 — 동기화됨';
  return '대기 중';
}

function refreshTray(): void {
  if (!tray) return;
  tray.setToolTip(`beatmania.app Synchronizer\n${trayLabel()}`);
  const menu = Menu.buildFromTemplate([
    { label: trayLabel(), enabled: false },
    { type: 'separator' },
    { label: '열기', click: showWindow },
    { label: '지금 보내기', click: () => void sync.syncNow() },
    { label: 'beatmania.app 열기', click: () => void shell.openExternal(settings.load().serverUrl) },
    ...(updateStatus.status === 'ready'
      ? [{ label: `업데이트 설치 (${updateStatus.version})`, click: () => { quitting = true; installNow(); } }]
      : []),
    { type: 'separator' },
    { label: '종료', click: () => void quit() },
  ]);
  tray.setContextMenu(menu);
}

async function quit(): Promise<void> {
  quitting = true;
  await sync.shutdown();
  app.quit();
}

function boot(): void {
  log(`시작 v${app.getVersion()}`);
  const s = settings.load();
  // 개발 중(npm start)에는 로그인 자동 실행을 건드리지 않는다.
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: s.launchAtLogin, args: ['--hidden'] });
  }

  tray = new Tray(nativeImage.createFromPath(join(ASSETS, 'tray-16.png')));
  tray.on('click', showWindow);
  createWindow();

  onLine(() => push());
  sync.onChange(() => push());
  sync.start();
  startUpdater((status, version) => {
    updateStatus = { status, version };
    push();
  });

  const hidden = process.argv.includes('--hidden');
  // 토큰이 없으면 처음 켤 때 창을 보여 준다 — 할 일이 있다는 뜻이다.
  if (!hidden || !settings.getToken()) showWindow();
  refreshTray();
}

// --- 화면과 주고받는 것 ------------------------------------------------------
ipcMain.handle('state:get', () => snapshot());
ipcMain.handle('token:set', (_e, token: string) => {
  settings.setToken(token);
  sync.tokenChanged();
  log(token.trim() ? 'API 토큰을 저장했습니다' : 'API 토큰을 지웠습니다');
  push();
});
ipcMain.handle('settings:launchAtLogin', (_e, on: boolean) => {
  settings.save({ launchAtLogin: on });
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
  push();
});
ipcMain.handle('sync:now', () => sync.syncNow());
ipcMain.handle('open:logs', () => shell.openPath(logDir()));
ipcMain.handle('open:site', (_e, path: string) =>
  shell.openExternal(settings.load().serverUrl.replace(/\/+$/, '') + (path || '/')));

app.on('window-all-closed', () => { /* 트레이에 남는다 */ });
app.on('before-quit', () => { quitting = true; });
