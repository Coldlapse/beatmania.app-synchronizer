// 골격 단계 화면 스크립트. preload 가 넘겨준 window.api 만 쓴다.
interface Api {
  getState(): Promise<any>;
  onState(fn: (s: any) => void): void;
  setToken(t: string): Promise<void>;
  setLaunchAtLogin(on: boolean): Promise<void>;
  syncNow(): Promise<void>;
  openLogs(): Promise<void>;
  openSite(path: string): Promise<void>;
}
const api = (window as unknown as { api: Api }).api;
const $ = (id: string) => document.getElementById(id)!;

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString('ko-KR', { hour12: false });
}

function describeUpload(u: any): string {
  if (!u) return '-';
  const r = u.result;
  const at = fmtTime(u.at);
  switch (r.kind) {
    case 'ok': return `${at} · 새 ${r.summary.created} / 갱신 ${r.summary.improved} / 못 찾음 ${r.summary.unmatched}`;
    case 'unauthorized': return `${at} · 토큰 오류`;
    case 'rate_limited': return `${at} · 잠시 뒤 다시`;
    case 'rejected': return `${at} · 거절됨`;
    default: return `${at} · 전송 실패`;
  }
}

function render(s: any): void {
  $('version').textContent = `v${s.version}` + (s.update?.status === 'ready' ? ` (업데이트 ${s.update.version} 준비됨)` : '');
  let summary = '대기 중';
  if (!s.tokenSet) summary = '토큰을 넣어 주세요';
  else if (s.tokenInvalid) summary = '토큰이 올바르지 않습니다';
  else if (s.busy) summary = s.busy;
  else if (s.game === 'running') summary = s.pending ? '보낼 기록이 있습니다' : '동기화됨';
  $('summary').textContent = summary;
  $('game').textContent = s.game === 'running' ? '실행 중' : s.game === 'stopped' ? '꺼져 있음' : '확인 못 함';
  $('reflux').textContent = s.mode === 'own' ? `이 앱이 실행 (PID ${s.refluxPid ?? '-'})`
    : s.mode === 'external' ? `다른 프로그램의 것을 사용 (PID ${s.refluxPid})` : '대기';
  $('last').textContent = describeUpload(s.lastUpload);
  const err = $('error');
  err.hidden = !s.error;
  err.textContent = s.error || '';
  ($('launch') as HTMLInputElement).checked = !!s.launchAtLogin;
  const pre = $('logText');
  pre.textContent = (s.log || []).slice(-60).join('\n');
  pre.scrollTop = pre.scrollHeight;
}

$('sync').addEventListener('click', async () => {
  const b = $('sync') as HTMLButtonElement;
  b.disabled = true;
  try { await api.syncNow(); } finally { b.disabled = false; }
});
$('saveToken').addEventListener('click', async () => {
  const i = $('tokenInput') as HTMLInputElement;
  await api.setToken(i.value);
  i.value = '';
});
$('launch').addEventListener('change', (e) => api.setLaunchAtLogin((e.target as HTMLInputElement).checked));
$('openToken').addEventListener('click', (e) => { e.preventDefault(); void api.openSite('/account/token/'); });
$('openLogs').addEventListener('click', (e) => { e.preventDefault(); void api.openLogs(); });

api.onState(render);
api.getState().then(render);
