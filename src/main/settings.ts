// 설정 — userData/settings.json.
//
// API 토큰은 평문으로 두지 않는다. Electron safeStorage(Windows 에서는 DPAPI)로
// 암호화한 값을 base64 로 저장한다. 같은 Windows 계정으로 로그인해야만 풀린다.
import { app, safeStorage } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export interface Settings {
  serverUrl: string;
  tokenEnc: string | null;
  username: string | null;     // 토큰 주인(/api/v1/me/). '내 서열표' 링크에 쓴다
  launchAtLogin: boolean;
}

const DEFAULTS: Settings = {
  serverUrl: 'https://beatmania.app',
  tokenEnc: null,
  username: null,
  launchAtLogin: true,
};

function file(): string {
  return join(app.getPath('userData'), 'settings.json');
}

let cache: Settings | null = null;

// 개발 중에만: 환경변수로 서버·토큰을 덮어써 가짜 서버로 시험한다. 설치판은 무시한다.
const devServer = () => (!app.isPackaged && process.env.BMSYNC_SERVER) || null;
const devToken = () => (!app.isPackaged && process.env.BMSYNC_TOKEN) || null;

export function load(): Settings {
  if (!cache) {
    try {
      cache = { ...DEFAULTS, ...JSON.parse(readFileSync(file(), 'utf-8')) };
    } catch {
      cache = { ...DEFAULTS };
    }
  }
  const server = devServer();
  return server ? { ...cache!, serverUrl: server } : cache!;
}

export function save(patch: Partial<Settings>): Settings {
  load();
  const next = { ...cache!, ...patch };      // 개발용 덮어쓰기가 파일에 저장되지 않게 cache 기준
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), JSON.stringify(next, null, 2), 'utf-8');
  cache = next;
  return next;
}

export function getToken(): string | null {
  if (devToken()) return devToken();
  const enc = load().tokenEnc;
  if (!enc) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    // 다른 PC·계정에서 옮겨 온 설정이면 풀리지 않는다. 없는 것으로 본다.
    return null;
  }
}

export function setToken(token: string | null): void {
  const t = token?.trim() || null;
  save({ tokenEnc: t ? safeStorage.encryptString(t).toString('base64') : null });
}
