// 화면 스크립트. preload 가 넘겨준 window.api 만 쓴다.
interface Api {
  getState(): Promise<any>;
  onState(fn: (s: any) => void): void;
  setToken(t: string): Promise<{ ok: boolean; error?: string; username?: string }>;
  setLaunchAtLogin(on: boolean): Promise<void>;
  syncNow(): Promise<void>;
  openLogs(): Promise<void>;
  openSite(path: string): Promise<void>;
  openProfile(): Promise<void>;
}
// preload 가 전역에 넣은 `api` 와 이름이 겹치면 SyntaxError 로 스크립트 전체가 멈춘다(실제로 빈 창이 떴다).
const bm = (window as unknown as { api: Api }).api;
const $ = (id: string) => document.getElementById(id)!;
let last: any = null;

// "3분 전" — 상대 시각. 30초마다 다시 그린다.
function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return '방금';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.round(h / 24)}일 전`;
}

// 한 줄 상태: [점 색, 제목, 부제]
function headline(s: any): [string, string, string] {
  const game = s.game === 'running' ? 'INFINITAS 실행 중' : s.game === 'stopped' ? 'INFINITAS 꺼짐' : 'INFINITAS 확인 못 함';
  const reflux = s.mode === 'own' ? 'Reflux 실행 중' : s.mode === 'external' ? '다른 프로그램의 Reflux 사용' : 'Reflux 대기';
  const sub = `${game} · ${reflux}`;
  if (s.tokenInvalid) return ['bad', '토큰이 올바르지 않습니다', '설정에서 토큰을 다시 넣어 주세요'];
  if (s.busy) return ['busy', s.busy, sub];
  if (s.error) return ['bad', '문제가 있습니다', sub];
  if (s.game === 'running') {
    return s.pending ? ['warn', '보낼 기록이 있습니다', sub] : ['ok', '동기화됨', sub];
  }
  return ['idle', '대기 중', 'INFINITAS 를 켜면 자동으로 시작합니다'];
}

function historyLine(h: any): string {
  switch (h.kind) {
    case 'ok': {
      const parts = [];
      if (h.created) parts.push(`새 기록 ${h.created}`);
      if (h.improved) parts.push(`갱신 ${h.improved}`);
      if (h.unmatched) parts.push(`못 찾은 곡 ${h.unmatched}`);
      return parts.join(' · ') || '변화 없음';
    }
    case 'unauthorized': return '토큰 오류';
    case 'rejected': return `거절됨 — ${h.message ?? ''}`;
    default: return h.message ?? '전송 실패';
  }
}

function render(s: any): void {
  last = s;
  const hasToken = !!s.tokenSet;
  $('onboard').hidden = hasToken;
  $('status').hidden = !hasToken;
  $('activity').hidden = !hasToken;

  const [cls, title, sub] = headline(s);
  $('dot').className = `dot ${cls}`;
  $('title').textContent = title;
  $('sub').textContent = sub;

  const u = s.lastUpload;
  const r = u?.result;
  $('lastWhen').textContent = u ? ago(u.at) : '아직 없음';
  const sum = r?.kind === 'ok' ? r.summary : null;
  $('nCreated').textContent = sum ? String(sum.created) : '-';
  $('nImproved').textContent = sum ? String(sum.improved) : '-';
  $('nUnmatched').textContent = sum ? String(sum.unmatched) : '-';
  const ses = s.session;
  $('session').textContent = ses && ses.uploads
    ? `이번 플레이: 새 기록 ${ses.created} · 갱신 ${ses.improved}` : '';

  const notice = $('notice');
  notice.hidden = !s.error;
  notice.textContent = s.error || '';

  ($('profile') as HTMLButtonElement).disabled = !s.username;

  const ul = $('history');
  ul.innerHTML = '';
  const items: any[] = s.history || [];
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '아직 기록이 없습니다';
    ul.appendChild(li);
  }
  for (const h of items.slice(0, 15)) {
    const li = document.createElement('li');
    const what = document.createElement('span');
    what.textContent = historyLine(h);
    if (h.kind !== 'ok') what.className = 'bad';
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = ago(h.at);
    li.append(what, when);
    ul.appendChild(li);
  }

  // 설정 판
  $('account').textContent = s.tokenInvalid ? '저장된 토큰을 서버가 받아 주지 않습니다. 사이트의 API 토큰을 다시 복사해 넣어 주세요.'
    : s.username ? `${s.username} 계정으로 연결되어 있습니다.`
    : hasToken ? '토큰이 저장되어 있습니다(계정 확인 전).' : '연결된 계정이 없습니다.';
  ($('launch') as HTMLInputElement).checked = !!s.launchAtLogin;
  $('refluxInfo').textContent = s.mode === 'own' ? `이 앱이 실행 (PID ${s.refluxPid ?? '-'})`
    : s.mode === 'external' ? `다른 프로그램의 것을 읽는 중 (PID ${s.refluxPid})` : '게임을 켜면 시작';
  const upd = s.update || {};
  const updText: Record<string, string> = {
    available: `새 버전 ${upd.version} 있음 — 다음에 켤 때 묻습니다`, skipped: `새 버전 ${upd.version} 알리지 않음`,
    downloading: `업데이트 ${upd.version ?? ''} 받는 중`, installing: `업데이트 ${upd.version ?? ''} 설치 중`,
    latest: '최신 버전', checking: '업데이트 확인 중', error: '업데이트 확인 실패', dev: '개발 실행',
  };
  $('versionInfo').textContent = `v${s.version ?? '-'} · ${updText[upd.status] ?? '-'}`;
  const pre = $('logText');
  pre.textContent = (s.log || []).slice(-40).join('\n');
  pre.scrollTop = pre.scrollHeight;
}

// 토큰 폼 (처음 설정 · 설정 판 두 곳)
document.querySelectorAll<HTMLFormElement>('[data-token-form]').forEach((form) => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = form.querySelector('input')!;
    const btn = form.querySelector('button')!;
    const msg = form.parentElement!.querySelector<HTMLElement>('[data-token-msg]')!;
    if (!input.value.trim()) return;
    btn.disabled = true;
    msg.className = 'form-msg';
    msg.textContent = '확인 중…';
    const r = await bm.setToken(input.value);
    btn.disabled = false;
    if (r.ok) {
      input.value = '';
      msg.className = 'form-msg ok';
      msg.textContent = `${r.username} 계정으로 연결했습니다.`;
    } else {
      msg.className = 'form-msg bad';
      msg.textContent = r.error || '연결하지 못했습니다.';
    }
  });
});

$('sync').addEventListener('click', async () => {
  const b = $('sync') as HTMLButtonElement;
  b.disabled = true;
  b.textContent = '보내는 중…';
  try { await bm.syncNow(); } finally { b.disabled = false; b.textContent = '지금 보내기'; }
});
$('profile').addEventListener('click', () => void bm.openProfile());
$('foldActivity').addEventListener('click', () => {
  const open = !$('activity').classList.contains('open');
  $('activity').classList.toggle('open', open);
  $('history').hidden = !open;
  $('foldActivity').setAttribute('aria-expanded', String(open));
});
$('openSettings').addEventListener('click', () => { $('settings').hidden = false; });
$('closeSettings').addEventListener('click', () => { $('settings').hidden = true; });
$('launch').addEventListener('change', (e) => bm.setLaunchAtLogin((e.target as HTMLInputElement).checked));
$('openLogs').addEventListener('click', (e) => { e.preventDefault(); void bm.openLogs(); });
$('clearToken').addEventListener('click', async (e) => {
  e.preventDefault();
  await bm.setToken('');
  $('settings').hidden = true;
});
document.querySelectorAll<HTMLAnchorElement>('[data-site]').forEach((a) => {
  a.addEventListener('click', (e) => { e.preventDefault(); void bm.openSite(a.dataset.site!); });
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('settings').hidden = true; });

bm.onState(render);
bm.getState().then(render);
setInterval(() => last && render(last), 30000);
