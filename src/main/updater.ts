// 앱 자동 업데이트 — GitHub Releases(Coldlapse/beatmania.app-synchronizer).
//
// 설치판에서만 돈다. 앱을 켤 때 한 번 확인하고, 새 버전이 있으면 묻는다:
//   예                    → 받아서 바로 설치하고 다시 켠다
//   아니요                → 이번 실행에서는 넘긴다(다음에 켤 때 다시 묻는다)
//   이번 버전 알리지 않기 → 그 버전만 다시 묻지 않는다. 더 새 버전이 나오면 다시 묻는다
// 전에는 조용히 받아 두었다가 앱을 끌 때 설치했다 — 언제 바뀌는지 알 수 없었다(사용자 결정 2026-09-26).
// 켜 두는 동안에도 6시간마다 확인하지만, 그때는 묻지 않고 화면의 버전 줄에만 알린다.
import { app } from 'electron';
import { autoUpdater, UpdateInfo } from 'electron-updater';

import { log } from './log';
import * as settings from './settings';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export type UpdateStatus =
  | 'idle' | 'checking' | 'latest' | 'error' | 'dev'
  | 'available'      // 새 버전이 있다(아니요, 또는 켜 둔 동안 확인됨)
  | 'skipped'        // '이번 버전 알리지 않기' 를 고른 버전
  | 'downloading' | 'installing';

export type Answer = 'yes' | 'no' | 'skip';

export function startUpdater(
  onStatus: (s: UpdateStatus, version?: string) => void,
  ask: (version: string) => Promise<Answer>,
  beforeInstall: () => Promise<void>,
): void {
  if (!app.isPackaged) {
    onStatus('dev');
    return;
  }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;

  let asked = false;          // 묻는 것은 켤 때 한 번
  let busy = false;           // 받는 중·설치 중에는 다시 확인하지 않는다

  autoUpdater.on('checking-for-update', () => { if (!busy) onStatus('checking'); });
  autoUpdater.on('update-not-available', () => { if (!busy) onStatus('latest'); });
  autoUpdater.on('update-available', (i: UpdateInfo) => {
    if (busy) return;
    if (settings.load().skipVersion === i.version) {
      onStatus('skipped', i.version);
      return;
    }
    if (asked) {
      onStatus('available', i.version);
      return;
    }
    asked = true;
    void ask(i.version).then((a) => {
      if (a === 'yes') {
        busy = true;
        log(`새 버전 ${i.version} 을 받는 중`);
        onStatus('downloading', i.version);
        autoUpdater.downloadUpdate().catch(() => { /* error 이벤트가 처리 */ });
      } else if (a === 'skip') {
        settings.save({ skipVersion: i.version });
        log(`새 버전 ${i.version} 은 알리지 않습니다`);
        onStatus('skipped', i.version);
      } else {
        onStatus('available', i.version);
      }
    });
  });
  autoUpdater.on('update-downloaded', (i: UpdateInfo) => {
    log(`새 버전 ${i.version} 을 설치하고 다시 켭니다`);
    onStatus('installing', i.version);
    // Reflux 를 먼저 정리한다 — 설치 프로그램이 앱을 강제로 끄면 Reflux 가 남는다.
    void beforeInstall().then(() => autoUpdater.quitAndInstall(true, true));
  });
  autoUpdater.on('error', (e) => {
    busy = false;
    log(`업데이트 실패: ${e.message}`);
    onStatus('error');
  });

  const check = () => { if (!busy) autoUpdater.checkForUpdates().catch(() => { /* error 이벤트가 처리 */ }); };
  check();
  setInterval(check, CHECK_EVERY_MS);
}
