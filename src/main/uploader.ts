// tracker.tsv 를 beatmania.app 에 보낸다.
//
// 서버(POST /api/v1/records/)는 파일을 통째로 받아 "지금 기록보다 좋을 때만"
// 반영하고, 같은 파일을 다시 받아도 결과가 같다. 그래서 여기서는 차이를 계산하지
// 않고 파일을 그대로 보낸다. 판단은 전부 서버에 있다 — 규칙을 고칠 때 앱을
// 다시 배포하지 않아도 된다.

export interface UploadSummary {
  charts: number;
  created: number;
  improved: number;
  unchanged: number;
  unmatched: number;
  unmatched_titles: string[];
}

export type UploadResult =
  | { kind: 'ok'; summary: UploadSummary }
  | { kind: 'unauthorized' }                       // 토큰이 없거나 틀림 — 고칠 때까지 멈춘다
  | { kind: 'rate_limited'; retryAfterSec: number }
  | { kind: 'rejected'; status: number; error: string }   // 파일이 이상함 — 같은 파일은 다시 안 보낸다
  | { kind: 'network'; error: string };             // 잠시 뒤 다시

export type WhoAmI =
  | { kind: 'ok'; username: string }
  | { kind: 'unauthorized' }
  | { kind: 'network'; error: string };

/** 토큰이 누구의 것인지. 토큰을 넣는 순간 맞는지 확인하는 데 쓴다. */
export async function whoami(serverUrl: string, token: string, version: string): Promise<WhoAmI> {
  try {
    const res = await fetch(`${serverUrl.replace(/\/+$/, '')}/api/v1/me/`, {
      headers: { Authorization: `Token ${token}`, 'User-Agent': `beatmania.app-synchronizer/${version}` },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401 || res.status === 403) return { kind: 'unauthorized' };
    if (!res.ok) return { kind: 'network', error: `HTTP ${res.status}` };
    const j = (await res.json()) as { username?: string };
    return j.username ? { kind: 'ok', username: j.username } : { kind: 'network', error: '응답 형식이 다릅니다' };
  } catch (e) {
    return { kind: 'network', error: (e as Error).message };
  }
}

export async function upload(serverUrl: string, token: string, body: Buffer,
                             version: string): Promise<UploadResult> {
  let res: Response;
  try {
    res = await fetch(`${serverUrl.replace(/\/+$/, '')}/api/v1/records/`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${token}`,
        'Content-Type': 'text/tab-separated-values; charset=utf-8',
        'User-Agent': `beatmania.app-synchronizer/${version}`,
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    return { kind: 'network', error: (e as Error).message };
  }

  if (res.status === 200) {
    return { kind: 'ok', summary: (await res.json()) as UploadSummary };
  }
  if (res.status === 401 || res.status === 403) return { kind: 'unauthorized' };
  if (res.status === 429) {
    const s = Number(res.headers.get('Retry-After')) || 30;
    return { kind: 'rate_limited', retryAfterSec: s };
  }
  let error = `HTTP ${res.status}`;
  try {
    const j = (await res.json()) as { error?: string };
    if (j.error) error = j.error;
  } catch { /* 본문이 JSON 이 아님(프록시 오류 화면 등) */ }
  // 5xx 는 서버 사정이라 잠시 뒤 다시 보낸다. 4xx 는 파일 문제로 본다.
  return res.status >= 500 ? { kind: 'network', error } : { kind: 'rejected', status: res.status, error };
}
