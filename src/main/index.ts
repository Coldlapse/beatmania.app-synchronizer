// beatmania.app Synchronizer — 진입점.
//
// 트레이에 상주한다. 창을 닫아도 꺼지지 않고 트레이로 숨는다. 끄려면 트레이 메뉴의
// "종료". Windows 로그인 때 창 없이(--hidden) 뜬다.
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, shell, Tray } from 'electron';
import { join } from 'path';

import { log, logDir, onLine, recent } from './log';
import * as settings from './settings';
import { Sync } from './sync';
import { installNow, startUpdater, UpdateStatus } from './updater';
import { whoami } from './uploader';

const ASSETS = join(__dirname, '..', '..', 'assets');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let updateStatus: { status: UpdateStatus; version?: string } = { status: 'idle' };
// safeStorage(토큰 복호화)는 앱이 준비된 뒤에만 쓸 수 있다. 그래서 boot 에서 만든다.
let sync: Sync | null = null;
// 저장된 토큰을 서버가 거부했다(시작할 때 확인). 화면에 '다시 넣어 주세요' 를 띄운다.
let tokenInvalid = false;

// 개발 실행(npm start)은 설치판과 다른 설정 폴더를 쓴다. 전에는 같은 폴더를 써서, 개발 중 dev 서버에
// 넣은 토큰과 계정 이름이 설치판 설정에 그대로 남았다 — 설치판이 라이브에서 거부되는 토큰을 들고
// 'sadang 계정으로 연결' 이라고 보여 줬다(2026-09-26). 한 번에 하나만 뜨게 하는 잠금도 폴더 기준이라,
// 개발 실행이 떠 있으면 설치판을 눌러도 개발 실행 창이 올라왔다. 둘 다 여기서 갈라진다.
if (!app.isPackaged) app.setPath('userData', app.getPath('userData') + ' (dev)');

if (!app.requestSingleInstanceLock()) {
  // 이미 떠 있다. 그쪽 창을 띄우게 하고 이쪽은 끈다.
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(boot);
}

function snapshot() {
  const s = settings.load();
  return {
    ...(sync?.state ?? {}),
    update: updateStatus,
    launchAtLogin: s.launchAtLogin,
    serverUrl: s.serverUrl,
    username: s.username,
    tokenInvalid,
    log: recent(),
  };
}

function push(): void {
  win?.webContents.send('state', snapshot());
  refreshTray();
}

function createWindow(): void {
  win = new BrowserWindow({
    // 크기 고정. 길어지는 것(최근 활동·로그)은 화면 안에서 그 칸만 스크롤한다.
    width: 420,
    height: 600,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    autoHideMenuBar: true,
    title: 'beatmania.app Synchronizer',
    icon: join(ASSETS, 'icon.png'),       // 작업 표시줄 — 32px 트레이 아이콘을 쓰면 흐리게 커진다
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // 화면 쪽 오류를 앱 로그에 남긴다. 사용자 PC 에서 창이 비어 보일 때 원인을 볼 곳이 이것뿐이다.
  win.webContents.on('preload-error', (_e, path, err) => log(`preload 오류 (${path}): ${err.message}`));
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) log(`화면 오류: ${message} (${source}:${line})`);
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
  const s = sync?.state;
  if (!s) return '준비 중';
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
    { label: '지금 보내기', click: () => void sync?.syncNow() },
    { label: '내 서열표 열기', click: openProfile },
    ...(updateStatus.status === 'ready'
      ? [{ label: `업데이트 설치 (${updateStatus.version})`, click: () => { quitting = true; installNow(); } }]
      : []),
    { type: 'separator' },
    { label: '종료', click: () => void quit() },
  ]);
  tray.setContextMenu(menu);
}

function siteUrl(path: string): string {
  return settings.load().serverUrl.replace(/\/+$/, '') + path;
}

function openProfile(): void {
  const u = settings.load().username;
  void shell.openExternal(siteUrl(u ? `/u/${encodeURIComponent(u)}/` : '/sync/'));
}

function notify(title: string, body: string): void {
  log(`알림: ${title} — ${body}`);
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: join(ASSETS, 'icon.png') });
  n.on('click', showWindow);
  n.show();
}

async function quit(): Promise<void> {
  quitting = true;
  await sync?.shutdown();
  app.quit();
}

/** 저장된 토큰의 주인을 확인해 둔다. 네트워크가 없으면 다음 기회로 미룬다. */
async function refreshUsername(): Promise<void> {
  const token = settings.getToken();
  if (!token) return;
  const r = await whoami(settings.load().serverUrl, token, app.getVersion());
  if (r.kind === 'unauthorized') {
    // 전에는 아무것도 하지 않아 예전 계정 이름이 '연결되어 있습니다' 로 계속 보였다.
    tokenInvalid = true;
    settings.save({ username: null });
    log('저장된 API 토큰을 서버가 받아 주지 않습니다 — 사이트에서 다시 복사해 넣어 주세요');
    push();
    return;
  }
  if (r.kind === 'ok') {
    tokenInvalid = false;
    if (r.username !== settings.load().username) settings.save({ username: r.username });
    push();
  }
}

function boot(): void {
  log(`시작 v${app.getVersion()}`);
  const s = settings.load();
  // 개발 중(npm start)에는 로그인 자동 실행을 건드리지 않는다.
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: s.launchAtLogin, args: ['--hidden'] });
  }

  sync = new Sync();
  tray = new Tray(nativeImage.createFromPath(join(ASSETS, 'tray-16.png')));
  tray.on('click', showWindow);
  createWindow();

  onLine(() => push());
  sync.onChange(() => push());
  // 플레이 중에는 알림으로 방해하지 않는다. 게임을 끌 때 한 번만 요약한다.
  sync.onSummary((ss) => {
    if (ss.created || ss.improved) {
      notify('이번 플레이를 서열표에 반영했습니다', `새 기록 ${ss.created} · 갱신 ${ss.improved}`);
    }
  });
  // 손봐야 하는 문제는 바로 알린다(같은 문제는 한 번만).
  sync.onIssue((msg) => notify('beatmania.app Synchronizer', msg));
  sync.start();
  void refreshUsername();
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

/** 토큰을 서버에 확인한 뒤에만 저장한다. 틀린 토큰으로 조용히 실패하는 일을 막는다. */
ipcMain.handle('token:set', async (_e, token: string) => {
  const t = (token || '').trim();
  if (!t) {
    settings.setToken(null);
    settings.save({ username: null });
    tokenInvalid = false;
    sync?.tokenChanged();
    log('API 토큰을 지웠습니다');
    push();
    return { ok: true };
  }
  const r = await whoami(settings.load().serverUrl, t, app.getVersion());
  if (r.kind === 'unauthorized') return { ok: false, error: '토큰이 맞지 않습니다. 사이트에서 다시 복사해 주세요.' };
  if (r.kind === 'network') return { ok: false, error: `서버에 닿지 않습니다 (${r.error})` };
  settings.setToken(t);
  settings.save({ username: r.username });
  tokenInvalid = false;
  sync?.tokenChanged();
  log(`API 토큰을 저장했습니다 (${r.username})`);
  push();
  return { ok: true, username: r.username };
});
ipcMain.handle('settings:launchAtLogin', (_e, on: boolean) => {
  settings.save({ launchAtLogin: on });
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
  push();
});
ipcMain.handle('sync:now', () => sync?.syncNow());
ipcMain.handle('open:logs', () => shell.openPath(logDir()));
ipcMain.handle('open:profile', () => openProfile());
ipcMain.handle('open:site', (_e, path: string) => shell.openExternal(siteUrl(path || '/')));

app.on('window-all-closed', () => { /* 트레이에 남는다 */ });
app.on('before-quit', () => { quitting = true; });
