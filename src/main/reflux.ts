// Reflux 설치·실행 — 앱이 직접 Reflux 를 띄우는 경우("자체 모드")에만 쓴다.
//
// Reflux(https://github.com/olji/Reflux, MIT)는 INFINITAS 메모리를 읽어
// tracker.tsv 를 쓰는 프로그램이다. 원본은 2026-05 이후 갱신이 없어 게임 패치를
// 따라가지 못한다. 그래서 패치 대응이 올라오는 포크(OhSorry-DP/Reflux, MIT)의
// 릴리스를 받는다. 실행 파일·offsets.txt 는 릴리스에서, 보조 파일은 포크 저장소에서.
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
const exePath = () => join(workDir(), 'Reflux.exe');
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
