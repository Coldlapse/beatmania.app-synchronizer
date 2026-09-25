// 앱 자동 업데이트 — GitHub Releases(Coldlapse/beatmania.app-synchronizer).
//
// 설치판에서만 돈다. 새 버전을 받아 두었다가 앱을 끌 때 설치한다. 게임 중에
// 창을 띄워 묻지 않는다 — 상주 앱이 플레이를 방해하면 안 된다.
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

import { log } from './log';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'ready' | 'latest' | 'error' | 'dev';

export function startUpdater(onStatus: (s: UpdateStatus, version?: string) => void): void {
  if (!app.isPackaged) {
    onStatus('dev');
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => onStatus('checking'));
  autoUpdater.on('update-available', (i) => {
    log(`새 버전 ${i.version} 을 받는 중`);
    onStatus('downloading', i.version);
  });
  autoUpdater.on('update-not-available', () => onStatus('latest'));
  autoUpdater.on('update-downloaded', (i) => {
    log(`새 버전 ${i.version} 준비됨 — 앱을 끌 때 설치됩니다`);
    onStatus('ready', i.version);
  });
  autoUpdater.on('error', (e) => {
    log(`업데이트 확인 실패: ${e.message}`);
    onStatus('error');
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => { /* error 이벤트가 처리 */ });
  check();
  setInterval(check, CHECK_EVERY_MS);
}

export function installNow(): void {
  autoUpdater.quitAndInstall();
}
