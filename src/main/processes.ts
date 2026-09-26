// Windows 프로세스 조회·종료.
//
// PATH 에 의존하지 않고 System32 절대 경로를 쓴다. 로그인 시 자동 실행 같은
// 환경에서는 PATH 가 짧을 수 있다.
import { execFile } from 'child_process';

const SYS32 = `${process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'}\\System32`;

function run(file: string, args: string[], timeoutMs = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.toString());
    });
  });
}

/** 이미지 이름으로 떠 있는 프로세스의 PID 목록. 조회 자체가 실패하면 null. */
export async function listPids(image: string): Promise<number[] | null> {
  try {
    const out = await run(`${SYS32}\\tasklist.exe`,
      ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH']);
    const pids: number[] = [];
    for (const line of out.split(/\r?\n/)) {
      // "Reflux.exe","1234","Console","1","12,345 K"
      const m = line.match(/^"([^"]+)","(\d+)"/);
      if (m && m[1].toLowerCase() === image.toLowerCase()) pids.push(Number(m[2]));
    }
    return pids;
  } catch {
    return null;
  }
}

/** 실행 파일 경로. 남이 띄운 Reflux 가 어디서 tracker.tsv 를 쓰는지 알아내는 데 쓴다. */
export async function processPath(pid: number): Promise<string | null> {
  try {
    const out = await run(`${SYS32}\\WindowsPowerShell\\v1.0\\powershell.exe`,
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).Path`]);
    const p = out.trim();
    return p || null;
  } catch {
    return null;
  }
}

export interface ProcInfo { pid: number; ppid: number; path: string | null }

/**
 * 이름이 같은 프로세스들의 PID·부모 PID·실행 경로. 조회가 실패하면 null.
 * 부모 PID 는 권한과 상관없이 읽히고, 경로는 권한이 없으면(관리자로 뜬 것, 백신 샌드박스 등) null 이다.
 * tasklist 보다 느려(PowerShell) 매 틱이 아니라 '모르는 Reflux' 가 보일 때만 부른다.
 */
export async function processInfo(image: string): Promise<ProcInfo[] | null> {
  try {
    const name = image.replace(/'/g, "''");
    const out = await run(`${SYS32}\\WindowsPowerShell\\v1.0\\powershell.exe`,
      ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='${name}'" | ` +
        `ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.ParentProcessId, $_.ExecutablePath }`]);
    const list: ProcInfo[] = [];
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\|(\d+)\|(.*)$/);
      if (m) list.push({ pid: Number(m[1]), ppid: Number(m[2]), path: m[3] || null });
    }
    return list;
  } catch {
    return null;
  }
}

/** PID 하나만 끈다. 이름으로 전부 끄지 않는다 — 남(INF오소리 등)의 Reflux 를 건드리지 않기 위해. */
export async function killPid(pid: number): Promise<void> {
  try {
    await run(`${SYS32}\\taskkill.exe`, ['/PID', String(pid), '/T', '/F']);
  } catch { /* 이미 없음 */ }
}
