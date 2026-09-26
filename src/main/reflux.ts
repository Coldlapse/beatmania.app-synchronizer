// Reflux 설치·실행 — 앱이 직접 Reflux 를 띄우는 경우("자체 모드")에만 쓴다.
//
// Reflux(https://github.com/olji/Reflux, MIT)는 INFINITAS 메모리를 읽어
// tracker.tsv 를 쓰는 프로그램이다. 원본은 2026-05 이후 갱신이 없어 게임 패치를
// 따라가지 못한다. 그래서 패치 대응이 올라오는 포크(OhSorry-DP/Reflux, MIT)의
// 릴리스를 받는다. 실행 파일·offsets.txt 는 릴리스에서, 보조 파일은 포크 저장소에서.
// 주소(offsets.txt)는 그 뒤 오소리 gist 에 더 새 판이 있으면 그것으로 덮어쓴다(아래 syncOffsetsFromGist).
//
// 이 앱은 자기가 띄운 Reflux 만 끈다(PID 로). 이름으로 전부 끄면 INF오소리 같은
// 다른 프로그램의 Reflux 까지 죽인다.
import { app } from 'electron';
import { createWriteStream, existsSync } from 'fs';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { execFile } from 'child_process';

import { log } from './log';
import { killPid, listPids } from './processes';

const REPO = 'OhSorry-DP/Reflux';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/master/Reflux`;
const SUPPORT_FILES = ['customtypes.txt', 'encodingfixes.txt', 'beginners.txt'];
const UA = { 'User-Agent': 'beatmania.app-synchronizer' };

// 기록은 로컬 tracker.tsv 로만 남긴다. 원격 전송(saveremote)은 끈다 — 전송은
// 이 앱이 파일을 읽어 한다. Reflux 의 원격 전송은 200 이 올 때까지 쉬지 않고
// 재시도하는 구조라 서버 쪽에 부담이 크다.
// updateserver 를 포크로 둔다. 원본을 가리키면 Reflux 가 스스로 옛 파일을 받는다.
const DEFAULT_CONFIG = `[Update]
updatefiles = true
updateserver = "${RAW_BASE}/"

[Record]
saveremote = false
savelocal = true
savejson = false
savelatestjson = false
savelatesttxt = false

[LocalRecord]
songinfo = true
chartdetails = true
resultdetails = true
judge = true
settings = true
uselocaltime = true

[Livestream]
showplaystate = false
enablemarquee = false
enablefullsonginfo = false
marqueeidletext = ""

[Debug]
outputdb = false
`;

export function workDir(): string {
  return join(app.getPath('userData'), 'Reflux');
}
export function ownTsvPath(): string {
  return join(workDir(), 'tracker.tsv');
}
export const exePath = () => join(workDir(), 'Reflux.exe');
const tagPath = () => join(workDir(), '.release-tag');

interface Release {
  tag_name: string;
  assets: { name: string; browser_download_url: string; size: number }[];
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: UA, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${url}`);
  const tmp = dest + '.download';
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(tmp));
  await rename(tmp, dest);
}

/** 없으면 설치, 포크에 새 릴리스가 있으면 갱신. 오프라인이면 있는 것으로 버틴다. */
export async function ensureInstalled(): Promise<void> {
  await mkdir(workDir(), { recursive: true });
  const hasExe = existsSync(exePath());
  let rel: Release | null = null;
  try {
    const res = await fetch(RELEASES_API, { headers: { ...UA, Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rel = (await res.json()) as Release;
  } catch (e) {
    if (!hasExe) throw new Error(`Reflux 릴리스를 확인하지 못했습니다: ${(e as Error).message}`);
    log(`Reflux 릴리스 확인 실패 — 설치된 것을 그대로 씁니다 (${(e as Error).message})`);
  }

  const localTag = existsSync(tagPath()) ? (await readFile(tagPath(), 'utf-8')).trim() : null;
  if (rel && (!hasExe || localTag !== rel.tag_name)) {
    log(`Reflux ${localTag ?? '(없음)'} → ${rel.tag_name} 받는 중`);
    for (const name of ['Reflux.exe', 'offsets.txt']) {
      const a = rel.assets.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!a) {
        if (name === 'Reflux.exe') throw new Error('릴리스에 Reflux.exe 가 없습니다');
        continue;
      }
      await download(a.browser_download_url, join(workDir(), name));
    }
    await writeFile(tagPath(), rel.tag_name, 'utf-8');
    log(`Reflux ${rel.tag_name} 설치 완료`);
  }

  // Reflux 는 시작하자마자 이 파일들을 읽고, 없으면 죽는다.
  for (const name of SUPPORT_FILES) {
    const dest = join(workDir(), name);
    if (existsSync(dest)) continue;
    try {
      await download(`${RAW_BASE}/${name}`, dest);
    } catch (e) {
      await writeFile(dest, '', 'utf-8');
      log(`${name} 를 받지 못해 빈 파일로 둡니다 (${(e as Error).message})`);
    }
  }
  const cfg = join(workDir(), 'config.ini');
  if (!existsSync(cfg)) await writeFile(cfg, DEFAULT_CONFIG, 'utf-8');

  await syncOffsetsFromGist();
}

// --- 오프셋: 오소리 gist ---------------------------------------------------------
//
// 게임 패치로 메모리 주소가 바뀌면 Reflux 는 offsets.txt 의 새 판이 있어야 기록을 읽는다.
// 포크 저장소·릴리스는 메모리 '구조' 가 바뀌어 코드를 고칠 때만 갱신되고, 주소만 바뀌는 패치는
// 오소리 개발자의 gist(offsets.json)에만 올라간다(2026-09-26 확인. 08-05 패치 때도 gist 가 1.5시간 먼저).
// 그래서 Reflux 를 켜기 전에 gist 를 보고, 디스크보다 새 판이면 offsets.txt 를 그것으로 쓴다.
//
// Reflux 는 켜질 때 게임의 빌드 번호(P2D:J:B:A:YYYYMMDDxx)를 직접 읽어 offsets.txt 첫 줄과 비교한다.
// 같으면 그대로 쓰고, 다르면 updateserver(포크)에서 찾고, 거기도 없으면 콘솔에서 사람이 조작하는
// 수동 검색으로 빠진다 — 이 앱이 띄운 Reflux 는 그 자리에서 멈춘다. 이 동기화가 그걸 막는다.
//
// gist 의 builds[0] 이 최신 빌드다. 실행 중인 게임 빌드를 직접 읽어 고르지는 않는다(INF오소리는
// 게임 메모리를 읽어 고른다) — 게임은 늘 최신으로 업데이트되므로 최신 판을 쓰고, 버전이 다르면
// Reflux 가 위 순서로 알아서 처리한다. 디스크가 더 새 판이면(포크 릴리스가 앞선 경우) 건드리지 않는다.
const GIST_OFFSETS_URL =
  'https://gist.githubusercontent.com/OhSorry-DP/30c3ba6f87df9847291c42ea216a8d2a/raw/offsets.json';
const OFFSET_KEYS = ['songList', 'unlockdata', 'playSettings', 'playData', 'currentsong', 'judgeData', 'datamap'];

/** offsets.txt 첫 줄(또는 빌드 문자열) 끝의 YYYYMMDDxx. 없으면 0. 클수록 최신. */
export function offsetsVersionNum(text: string): number {
  const first = (text || '').split(/\r?\n/)[0]?.trim() ?? '';
  const m = first.match(/(\d{10})\s*$/);
  return m ? parseInt(m[1], 10) : 0;
}

interface GistBuild { version: string; reflux?: Record<string, string> }

/** gist JSON 에서 최신 빌드를 고른다(v2 는 builds[0], v1 은 최상위). 쓸 수 없으면 null. */
export function latestGistBuild(j: unknown): GistBuild | null {
  const o = j as { version?: unknown; reflux?: unknown; builds?: unknown };
  const builds = Array.isArray(o?.builds) ? (o.builds as GistBuild[]).filter((b) => b && typeof b.version === 'string') : [];
  const b = builds[0] ?? (typeof o?.version === 'string' ? { version: o.version, reflux: o.reflux as Record<string, string> } : null);
  if (!b || !b.reflux || !offsetsVersionNum(b.version)) return null;
  // 주소가 하나라도 빠지면 Reflux 가 그 항목을 못 읽는다 — 불완전한 판은 쓰지 않는다
  if (!OFFSET_KEYS.every((k) => typeof b.reflux![k] === 'string' && /^0x[0-9a-f]+$/i.test(b.reflux![k]))) return null;
  return b;
}

export function offsetsText(b: GistBuild): string {
  return b.version.trim() + '\n' + OFFSET_KEYS.map((k) => `${k} = ${b.reflux![k]}`).join('\n') + '\n';
}

async function syncOffsetsFromGist(): Promise<void> {
  const dest = join(workDir(), 'offsets.txt');
  const diskVer = existsSync(dest) ? offsetsVersionNum(await readFile(dest, 'utf-8')) : 0;
  let build: GistBuild | null = null;
  try {
    const res = await fetch(`${GIST_OFFSETS_URL}?t=${Date.now()}`, { headers: UA, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    build = latestGistBuild(await res.json());
    if (!build) throw new Error('형식이 다릅니다');
  } catch (e) {
    log(`오프셋 gist 확인 실패 — 있는 offsets.txt 를 씁니다 (${(e as Error).message})`);
    return;
  }
  const gistVer = offsetsVersionNum(build.version);
  if (gistVer <= diskVer) return;
  await writeFile(dest, offsetsText(build), 'utf-8');
  log(`오프셋 갱신 (gist): ${diskVer || '없음'} → ${gistVer}`);
}

let ownPid: number | null = null;

export function getOwnPid(): number | null {
  return ownPid;
}

/**
 * Reflux 를 숨긴 콘솔로 띄운다.
 *
 * 표준 입출력을 파이프로 잡고 직접 spawn 하면 Reflux 의 Console 호출이 콘솔
 * 핸들을 못 찾아 죽을 수 있다. PowerShell Start-Process 로 숨긴 콘솔을 붙여
 * 띄우고, -PassThru 로 PID 를 받아 둔다(나중에 그 PID 만 끈다).
 */
export async function start(): Promise<number> {
  if (ownPid && (await isOwnAlive())) return ownPid;
  const sys32 = `${process.env.SystemRoot || 'C:\\Windows'}\\System32`;
  const ps = `${sys32}\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const q = (s: string) => s.replace(/'/g, "''");
  const cmd = `$p = Start-Process -FilePath '${q(exePath())}' -WorkingDirectory '${q(workDir())}' ` +
    `-WindowStyle Hidden -PassThru; $p.Id`;
  const out: string = await new Promise((resolve, reject) => {
    execFile(ps, ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { windowsHide: true, timeout: 20000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout.toString())));
  });
  const pid = Number(out.trim().split(/\s+/).pop());
  if (!Number.isFinite(pid) || pid <= 0) throw new Error(`Reflux PID 를 받지 못했습니다: ${out}`);
  ownPid = pid;
  log(`Reflux 시작 (PID ${pid})`);
  return pid;
}

export async function isOwnAlive(): Promise<boolean> {
  if (!ownPid) return false;
  const pids = await listPids('Reflux.exe');
  if (pids === null) return true;          // 조회 실패 — 살아 있다고 보고 중복 실행을 막는다
  return pids.includes(ownPid);
}

export async function stop(): Promise<void> {
  if (!ownPid) return;
  const pid = ownPid;
  ownPid = null;
  await killPid(pid);
  log(`Reflux 종료 (PID ${pid})`);
}
