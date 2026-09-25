// 로그 — 화면에 보일 최근 줄(메모리)과 파일(userData/logs/app.log) 두 곳에 남긴다.
// 사용자가 문제를 알려 올 때 파일을 첨부받는 것이 가장 빠르다.
import { app } from 'electron';
import { appendFileSync, mkdirSync, statSync, renameSync } from 'fs';
import { join } from 'path';

const MAX_LINES = 200;
const MAX_FILE = 1024 * 1024;   // 1MB 를 넘으면 .old 로 한 번 돌린다
const lines: string[] = [];
let listener: ((line: string) => void) | null = null;

export function logDir(): string {
  return join(app.getPath('userData'), 'logs');
}

export function onLine(fn: (line: string) => void): void {
  listener = fn;
}

export function recent(): string[] {
  return lines.slice();
}

export function log(msg: string): void {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const line = `[${stamp}] ${msg}`;
  lines.push(line);
  if (lines.length > MAX_LINES) lines.shift();
  try {
    mkdirSync(logDir(), { recursive: true });
    const f = join(logDir(), 'app.log');
    try {
      if (statSync(f).size > MAX_FILE) renameSync(f, f + '.old');
    } catch { /* 아직 없음 */ }
    appendFileSync(f, line + '\n', 'utf-8');
  } catch { /* 로그 때문에 앱이 죽으면 안 된다 */ }
  listener?.(line);
}
