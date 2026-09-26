// beatmania.app Synchronizer — 진입점.
//
// 보통 창 앱이다. 켜 두는 동안 동기화하고, 창을 닫으면 앱이 꺼진다(트레이는 쓰지 않는다).
// Windows 로그인 때는 작업 표시줄에 내려 둔 채로(--minimized) 뜬다.
import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';
import { join } from 'path';

import { log, logDir, onLine, recent } from './log';
import * as settings from './settings';
import { Sync } from './sync';
import { Answer, startUpdater, UpdateStatus } from './updater';
import { whoami } from './uploader';

const ASSETS = join(__dirname, '..', '..', 'assets');

let win: BrowserWindow | null = null;
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
    icon: join(ASSETS, 'icon.png'),       // 작업 표시줄·창 아이콘(256px)
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
    // 닫기 = 앱 종료. 전에는 트레이로 숨었다 — 켜져 있는지 알기 어렵고 트레이에 있을 이유가 없었다
    // (사용자 결정 2026-09-26). Reflux 를 먼저 정리해야 해서 한 번 막고 quit() 으로 끈다.
    if (quitting) return;
    e.preventDefault();
    void quit();
  });
  // 창 안의 링크는 기본 브라우저로 연다.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWindow(): void {
  if (!win) createWindow();
  if (win!.isMinimized()) win!.restore();
  win!.show();
  win!.focus();
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
  if (quitting) return;
  quitting = true;
  log('종료');
  await sync?.shutdown();
  // 정리는 끝났다. app.quit() 은 창 닫기에서 이어 부르면 프로세스가 남는 경우가 있어(개발 실행에서
  // 재현, 2026-09-26) 확실히 끝내는 exit 을 쓴다 — Reflux 정리와 마지막 전송은 위에서 이미 했다.
  win?.destroy();
  app.exit(0);
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
    app.setLoginItemSettings({ openAtLogin: s.launchAtLogin, args: ['--minimized'] });
  }

  sync = new Sync();
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
  }, askUpdate, async () => {
    quitting = true;
    await sync?.shutdown();
  });

  // Windows 시작 때는 작업 표시줄에 내려 둔 채로 켠다(--minimized, 옛 설치판의 --hidden 도 같게).
  // 토큰이 없으면 할 일이 있다는 뜻이라 창을 띄운다.
  const minimized = process.argv.includes('--minimized') || process.argv.includes('--hidden');
  if (minimized && settings.getToken()) {
    win!.once('ready-to-show', () => { win!.showInactive(); win!.minimize(); });
  } else {
    showWindow();
  }
}

/** 새 버전이 있을 때 묻는다(켤 때 한 번). 창이 내려가 있으면 올린 뒤 묻는다. */
async function askUpdate(version: string): Promise<Answer> {
  showWindow();
  const r = await dialog.showMessageBox(win!, {
    type: 'info',
    title: 'beatmania.app Synchronizer',
    message: `새 버전 ${version} 이 있습니다. 지금 업데이트할까요?`,
    detail: `지금 버전은 ${app.getVersion()} 입니다. 예를 누르면 받아서 설치한 뒤 다시 켭니다.`,
    buttons: ['예', '아니요', '이번 버전 알리지 않기'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  return (['yes', 'no', 'skip'] as const)[r.response] ?? 'no';
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

app.on('before-quit', () => { quitting = true; });
