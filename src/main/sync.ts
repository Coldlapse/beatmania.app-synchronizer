// 동기화 루프 — 3초마다 한 번 돈다.
//
// 1. 게임(bm2dx.exe)과 Reflux 가 떠 있는지 본다.
// 2. 어느 tracker.tsv 를 볼지 정한다.
//      - 남이 띄운 Reflux 가 있으면(INF오소리 등) 그것이 쓰는 파일을 읽기만 한다.
//        INF오소리는 Reflux 를 띄울 때 이름으로 모든 Reflux.exe 를 끈다. 우리도
//        띄우면 서로 끄는 싸움이 난다. 그래서 먼저 떠 있는 쪽에 얹힌다.
//      - 없고 게임이 켜져 있으면 우리가 Reflux 를 띄운다.
// 3. 파일이 바뀌고 2초 동안 그대로면(쓰는 중이 아님) 보낼 거리로 표시한다.
// 4. 보낼 거리가 있으면 1분에 한 번까지 보낸다. 게임이 꺼지는 순간에는 기다리지
//    않고 바로 한 번 보낸다(마지막 곡을 놓치지 않게).
import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { readFile, stat } from 'fs/promises';
import { dirname, join } from 'path';

import { log } from './log';
import { listPids, processPath } from './processes';
import * as reflux from './reflux';
import * as settings from './settings';
import { upload, UploadResult } from './uploader';

const TICK_MS = 3000;
const STABLE_MS = 2000;
const MIN_INTERVAL_MS = 60 * 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;

// 화면의 '최근 활동'에 보이는 한 줄. 앱을 다시 켜도 남도록 파일에 둔다.
export interface HistoryItem {
  at: number;
  kind: UploadResult['kind'];
  created?: number;
  improved?: number;
  unmatched?: number;
  message?: string;
}
const HISTORY_MAX = 30;
const historyFile = () => join(app.getPath('userData'), 'history.json');

export interface State {
  version: string;
  tokenSet: boolean;
  tokenInvalid: boolean;
  game: 'running' | 'stopped' | 'unknown';
  mode: 'own' | 'external' | 'none';      // 누구의 Reflux 를 보고 있나
  refluxPid: number | null;
  tsvPath: string | null;
  pending: boolean;                       // 아직 안 보낸 변경이 있다
  busy: string | null;                    // "Reflux 설치 중" 같은 진행 중 작업
  error: string | null;                   // 마지막 문제(해결되면 지운다)
  lastUpload: { at: number; result: UploadResult } | null;
  nextUploadAt: number | null;
  session: { created: number; improved: number; uploads: number };   // 이번 게임 켠 뒤로
  history: HistoryItem[];
}

type Listener = (s: State) => void;
export interface SessionSummary { created: number; improved: number; uploads: number }

export class Sync {
  state: State;
  private listener: Listener | null = null;
  private onSessionEnd: ((s: SessionSummary) => void) | null = null;
  private onProblem: ((msg: string) => void) | null = null;
  private lastProblem: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  private seen: { mtime: number; size: number; since: number } | null = null;
  private sentMtime = -1;
  private nextAllowed = 0;
  private retryMs = 30000;
  private installBackoffUntil = 0;
  private foreignTsv = new Map<number, string | null>();

  constructor() {
    this.state = {
      version: app.getVersion(),
      tokenSet: !!settings.getToken(),
      tokenInvalid: false,
      game: 'unknown',
      mode: 'none',
      refluxPid: null,
      tsvPath: null,
      pending: false,
      busy: null,
      error: null,
      lastUpload: null,
      nextUploadAt: null,
      session: { created: 0, improved: 0, uploads: 0 },
      history: loadHistory(),
    };
  }

  /** 게임을 끌 때 이번 세션 요약을 받는다(알림용). */
  onSummary(fn: (s: SessionSummary) => void): void {
    this.onSessionEnd = fn;
  }

  /** 사용자가 손봐야 하는 문제가 새로 생기면 한 번 받는다(알림용). */
  onIssue(fn: (msg: string) => void): void {
    this.onProblem = fn;
  }

  private problem(msg: string | null): void {
    if (msg && msg !== this.lastProblem) this.onProblem?.(msg);
    this.lastProblem = msg;
  }

  private remember(item: HistoryItem): void {
    const history = [item, ...this.state.history].slice(0, HISTORY_MAX);
    this.set({ history });
    try {
      writeFileSync(historyFile(), JSON.stringify(history), 'utf-8');
    } catch { /* 기록 저장 실패로 동기화가 멈추면 안 된다 */ }
  }

  onChange(fn: Listener): void {
    this.listener = fn;
  }

  private set(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    this.listener?.(this.state);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  /** 토큰이 바뀌면 멈춰 있던 전송을 다시 시작한다. */
  tokenChanged(): void {
    this.set({ tokenSet: !!settings.getToken(), tokenInvalid: false });
    this.nextAllowed = 0;
  }

  /** 화면의 "지금 보내기". 1분 제한을 무시한다(서버의 10초 제한은 그대로). */
  async syncNow(): Promise<void> {
    this.sentMtime = -1;
    this.nextAllowed = 0;
    await this.tick(true);
  }

  /** 앱 종료 전에 한 번 보내고, 우리가 띄운 Reflux 를 끈다. */
  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.state.pending) await this.send(true);
    await reflux.stop();
  }

  private async tick(force = false): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.observe();
      await this.watchFile();
      await this.send(force);
    } catch (e) {
      log(`루프 오류: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async observe(): Promise<void> {
    // 개발 중에만: 게임 없이 Reflux 설치·실행 흐름을 시험하려고 "게임이 켜져 있다"고 친다.
    // 설치판(app.isPackaged)에서는 무시한다.
    // BMSYNC_GAME_FLAG 에 파일 경로를 주면 그 파일이 있는 동안만 켜진 것으로 친다(종료 흐름 시험용).
    const flag = process.env.BMSYNC_GAME_FLAG;
    const assume = !app.isPackaged && (process.env.BMSYNC_ASSUME_GAME === '1' || (!!flag && existsSync(flag)));
    const game = assume ? [0] : await listPids('bm2dx.exe');
    const refluxPids = await listPids('Reflux.exe');
    const gameState = game === null ? 'unknown' : game.length ? 'running' : 'stopped';
    const wasRunning = this.state.game === 'running';

    const own = reflux.getOwnPid();
    const ownAlive = own !== null && refluxPids !== null && refluxPids.includes(own);
    const foreign = (refluxPids ?? []).filter((p) => p !== own);

    if (foreign.length) {
      // 남의 Reflux 가 있다. 우리 것은 내린다.
      if (ownAlive) {
        log('다른 프로그램의 Reflux 가 떠 있어 이 앱의 Reflux 를 내립니다');
        await reflux.stop();
      }
      const pid = foreign[0];
      if (!this.foreignTsv.has(pid)) {
        const exe = await processPath(pid);
        this.foreignTsv.set(pid, exe ? join(dirname(exe), 'tracker.tsv') : null);
        log(`다른 Reflux(PID ${pid}) 의 기록을 읽습니다: ${this.foreignTsv.get(pid) ?? '(경로를 알 수 없음)'}`);
      }
      if (gameState === 'running' && !wasRunning) {
        this.set({ session: { created: 0, improved: 0, uploads: 0 } });
      }
      if (wasRunning && gameState === 'stopped') {
        await this.watchFile();
        if (this.state.pending) await this.send(true);
        if (this.state.session.uploads > 0) this.onSessionEnd?.(this.state.session);
      }
      this.set({ game: gameState, mode: 'external', refluxPid: pid, tsvPath: this.foreignTsv.get(pid) ?? null });
      return;
    }

    if (gameState === 'running' && !wasRunning) {
      this.set({ session: { created: 0, improved: 0, uploads: 0 } });
    }

    if (gameState === 'running') {
      if (!ownAlive && Date.now() >= this.installBackoffUntil) {
        try {
          this.set({ busy: 'Reflux 준비 중' });
          await reflux.ensureInstalled();
          await reflux.start();
          this.set({ error: null });
        } catch (e) {
          this.installBackoffUntil = Date.now() + 60000;
          this.set({ error: `Reflux 를 띄우지 못했습니다: ${(e as Error).message}` });
          log(this.state.error!);
          this.problem('Reflux 를 띄우지 못했습니다. 앱을 열어 확인해 주세요.');
        } finally {
          this.set({ busy: null });
        }
      }
      this.set({ game: gameState, mode: 'own', refluxPid: reflux.getOwnPid(), tsvPath: reflux.ownTsvPath() });
      return;
    }

    // 게임이 꺼져 있다. 막 꺼졌으면 남은 기록을 바로 보내고 우리 Reflux 를 내린다.
    if (wasRunning && gameState === 'stopped') {
      log('INFINITAS 종료 감지');
      await this.watchFile();
      if (this.state.pending) await this.send(true);
      if (ownAlive) await reflux.stop();
      if (this.state.session.uploads > 0) this.onSessionEnd?.(this.state.session);
    }
    this.set({ game: gameState, mode: 'none', refluxPid: null });
  }

  private async watchFile(): Promise<void> {
    const p = this.state.tsvPath;
    if (!p) return;
    let st;
    try {
      st = await stat(p);
    } catch {
      return;                                   // 아직 없음 — 게임에서 곡 선택 화면에 들어가면 생긴다
    }
    const mtime = st.mtimeMs;
    if (!this.seen || this.seen.mtime !== mtime || this.seen.size !== st.size) {
      this.seen = { mtime, size: st.size, since: Date.now() };
      return;
    }
    const stable = Date.now() - this.seen.since >= STABLE_MS;
    const pending = stable && st.size > 0 && mtime !== this.sentMtime;
    if (pending !== this.state.pending) this.set({ pending });
  }

  private async send(force: boolean): Promise<void> {
    if (!this.state.pending || !this.state.tsvPath || !this.seen) return;
    const token = settings.getToken();
    if (!token || this.state.tokenInvalid) return;
    if (!force && Date.now() < this.nextAllowed) {
      if (this.state.nextUploadAt !== this.nextAllowed) this.set({ nextUploadAt: this.nextAllowed });
      return;
    }

    const mtime = this.seen.mtime;
    const body = await readFile(this.state.tsvPath);
    const result = await upload(settings.load().serverUrl, token, body, this.state.version);
    const now = Date.now();

    switch (result.kind) {
      case 'ok': {
        const s = result.summary;
        this.sentMtime = mtime;
        this.nextAllowed = now + MIN_INTERVAL_MS;
        this.retryMs = 30000;
        log(`전송 완료 — 새 기록 ${s.created}, 갱신 ${s.improved}, 변화 없음 ${s.unchanged}, 못 찾은 곡 ${s.unmatched}`);
        const ses = this.state.session;
        this.set({ error: null, session: { created: ses.created + s.created,
          improved: ses.improved + s.improved, uploads: ses.uploads + 1 } });
        // 바뀐 것이 없으면 최근 활동을 어지럽히지 않는다.
        if (s.created || s.improved || s.unmatched) {
          this.remember({ at: now, kind: 'ok', created: s.created, improved: s.improved, unmatched: s.unmatched });
        }
        this.problem(null);
        break;
      }
      case 'unauthorized':
        log('토큰이 틀렸거나 만료됐습니다. 설정에서 다시 넣어 주세요');
        this.set({ tokenInvalid: true });
        this.remember({ at: now, kind: 'unauthorized', message: '토큰이 올바르지 않습니다' });
        this.problem('API 토큰이 올바르지 않습니다. 앱에서 다시 넣어 주세요.');
        break;
      case 'rate_limited':
        this.nextAllowed = now + result.retryAfterSec * 1000;
        break;
      case 'rejected':
        // 같은 파일을 다시 보내도 같은 답이다. 파일이 바뀔 때까지 기다린다.
        this.sentMtime = mtime;
        log(`서버가 파일을 거절했습니다 (${result.status}): ${result.error}`);
        this.set({ error: result.error });
        this.remember({ at: now, kind: 'rejected', message: result.error });
        break;
      case 'network':
        this.nextAllowed = now + this.retryMs;
        this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
        log(`전송 실패, ${Math.round((this.nextAllowed - now) / 1000)}초 뒤 다시: ${result.error}`);
        this.set({ error: `전송 실패: ${result.error}` });
        break;
    }
    this.set({
      lastUpload: { at: now, result },
      pending: mtime !== this.sentMtime,
      nextUploadAt: this.nextAllowed || null,
    });
  }
}


function loadHistory(): HistoryItem[] {
  try {
    const h = JSON.parse(readFileSync(historyFile(), 'utf-8'));
    return Array.isArray(h) ? h.slice(0, HISTORY_MAX) : [];
  } catch {
    return [];
  }
}
