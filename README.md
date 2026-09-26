# beatmania.app Synchronizer

beatmania IIDX INFINITAS 의 플레이 기록을 [beatmania.app](https://beatmania.app) 서열표로
자동 동기화하는 Windows 앱입니다.

켜 두는 동안 기록이 바뀌면 클리어 램프와 DJ 등급을
서열표에 반영합니다. 서열표에서 곡마다 손으로 입력하던 일을 없애는 것이 목적입니다.

> 아직 초기 버전(0.x)입니다. 화면은 다듬는 중입니다.

## 어떻게 동작하나요

```
INFINITAS ──(Reflux)──> tracker.tsv ──(이 앱)──> beatmania.app  POST /api/v1/records/
                                                     └ 지금 기록보다 좋을 때만 반영
```

1. 게임(`bm2dx.exe`)이 켜지면 [Reflux](https://github.com/olji/Reflux) 를 띄웁니다.
   Reflux 가 게임 메모리에서 기록을 읽어 `tracker.tsv` 파일로 씁니다.
2. 파일이 바뀌면 그 파일을 그대로 beatmania.app 에 보냅니다. **1분에 한 번까지**만 보내고,
   게임을 끄는 순간에는 기다리지 않고 한 번 더 보냅니다.
3. 서버가 곡을 찾아 **지금 기록보다 좋을 때만** 올립니다. 서열표에 직접 입력한 기록을
   낮추지 않고, 같은 파일을 여러 번 보내도 결과가 같습니다.

곡 매칭과 반영 규칙은 전부 서버에 있습니다. 규칙이 바뀌어도 앱을 다시 설치할 필요가 없습니다.

### INF오소리와 함께 쓰는 경우

[INF오소리](https://github.com/OhSorry-DP)도 Reflux 를 띄웁니다. 두 앱이 각자 Reflux 를
띄우면 서로 끄게 되므로, 이 앱은 **이미 떠 있는 다른 Reflux 가 있으면 자기 것을 띄우지 않고
그 Reflux 가 쓰는 `tracker.tsv` 를 읽기만** 합니다. 따로 설정하실 것은 없습니다.

## 설치

1. [최신 릴리스](https://github.com/Coldlapse/beatmania.app-synchronizer/releases/latest) 에서
   `beatmania.app-Synchronizer-Setup-<버전>.exe` 를 받아 실행합니다.
2. beatmania.app 에 로그인한 뒤 [API 토큰](https://beatmania.app/account/token/) 을 복사해
   앱의 **API 토큰** 칸에 넣습니다.
3. 게임을 켜고 곡 선택 화면에 한 번 들어가면 기록이 올라갑니다.

새 버전이 있으면 앱을 켤 때 묻습니다 — 예(받아서 설치 후 다시 켬) · 아니요(다음에 켤 때 다시 물음) · 이번 버전 알리지 않기(더 새 버전이 나오면 다시 물음).

> **"Windows에서 PC를 보호했습니다" 경고가 뜹니다.** 코드 서명 인증서가 없는 앱이라 처음
> 실행할 때 SmartScreen 이 경고합니다. **추가 정보 → 실행** 을 누르시면 됩니다.

## 무엇을 보내고 무엇을 저장하나요

| | |
|---|---|
| 보내는 것 | `tracker.tsv` 한 파일 (곡 제목, 채보별 램프·등급·EX 점수·미스 수). 그 밖의 파일은 보내지 않습니다 |
| 받는 곳 | `https://beatmania.app/api/v1/records/` 한 곳 |
| 토큰 | Windows 계정 단위로 암호화(DPAPI)해 `%APPDATA%\beatmania.app Synchronizer\settings.json` 에 둡니다 |
| 로그 | `%APPDATA%\beatmania.app Synchronizer\logs\app.log`. 문제가 있을 때 이 파일을 보내 주시면 됩니다 |

## 알아 두실 점

- 게임 메모리를 읽는 것은 Reflux 입니다. 널리 쓰이는 도구지만 KONAMI 가 공식으로 허용한
  방법은 아닙니다. 사용은 본인 판단에 맡깁니다.
- Reflux 는 원본(olji/Reflux)이 2026-05 이후 갱신되지 않아, 게임 패치에 대응이 올라오는
  포크 [OhSorry-DP/Reflux](https://github.com/OhSorry-DP/Reflux) 의 최신 릴리스를 받아 씁니다.
  둘 다 MIT 라이선스입니다. 이 앱은 Reflux 를 포함해 배포하지 않고 처음 필요할 때 받습니다.
- 게임 패치로 메모리 주소만 바뀌면 새 주소(오프셋)는 포크가 아니라 INF오소리 측의
  [gist](https://gist.github.com/OhSorry-DP/30c3ba6f87df9847291c42ea216a8d2a) 에만 올라옵니다(2026-06-03 패치가
  그랬습니다). 이 앱은 Reflux 를 켜기 전에 그 gist 를 보고, 더 새 판이면 `offsets.txt` 를 그것으로 씁니다.
- 이 앱은 자기가 띄운 Reflux 만 끕니다.

## 개발

```bash
npm install
npm start            # 빌드 후 실행
npm run typecheck
npm run dist         # 설치 파일을 release/ 에 만든다 (올리지 않음)
```

Node 22 LTS 를 권합니다. Node 24 에서는 `npm install` 이 Electron 바이너리 압축을 끝까지
풀지 못하는 경우가 있습니다(`Electron failed to install correctly`). 그때는 캐시에 받아진 zip 을
`node_modules/electron/dist` 에 직접 풀고 `node_modules/electron/path.txt` 에 `electron.exe` 를 적으면 됩니다.

개발 실행에서만 쓰는 환경변수입니다(설치판에서는 무시합니다).

| 변수 | 뜻 |
|---|---|
| `BMSYNC_ASSUME_GAME=1` | 게임이 켜져 있다고 보고 Reflux 설치·실행 흐름을 시험합니다 |
| `BMSYNC_GAME_FLAG` | 이 경로에 파일이 있는 동안만 게임이 켜진 것으로 봅니다(게임 종료 흐름 시험) |
| `BMSYNC_SERVER` | 보낼 서버 주소 (예: 로컬 dev 서버) |
| `BMSYNC_TOKEN` | 설정 대신 쓸 토큰 |

### 배포

`v*` 태그를 올리면 GitHub Actions 가 설치 파일을 만들어 Releases 에 올립니다.

```bash
npm version patch     # package.json 과 태그를 함께 올린다
git push --follow-tags
```

태그와 `package.json` 버전이 다르면 워크플로가 멈춥니다.

## 함께 쓰는 프로젝트

게임 기록을 읽는 부분은 다른 오픈소스에 기대고 있습니다.

| 프로젝트 | 하는 일 | 이 앱과의 관계 |
|---|---|---|
| [Reflux](https://github.com/olji/Reflux) (olji, MIT) | INFINITAS 실행 중 게임 기록을 읽어 `tracker.tsv` 로 남깁니다 | 이 앱이 읽는 파일을 만드는 도구입니다 |
| [OhSorry-DP/Reflux](https://github.com/OhSorry-DP/Reflux) (MIT) | 최신 INFINITAS 패치에 대응한 Reflux 포크입니다 | 원본이 2026-05 이후 갱신되지 않아, 이 앱은 이 포크의 릴리스를 받아 씁니다 |
| [INF오소리 오프셋 gist](https://gist.github.com/OhSorry-DP/30c3ba6f87df9847291c42ea216a8d2a) | 게임 패치마다 바뀌는 Reflux 메모리 주소를 빌드별로 공개합니다 | Reflux 를 켜기 전에 읽어, 더 새 판이면 `offsets.txt` 로 씁니다(데이터만 읽고 코드는 가져오지 않았습니다) |
| [INF오소리](https://github.com/OhSorry-DP) | 같은 Reflux 를 쓰는 기록 분석 앱입니다 | 함께 켜 두어도 부딪히지 않도록, INF오소리의 Reflux 가 떠 있으면 그 `tracker.tsv` 를 읽습니다. **INF오소리의 코드는 가져오지 않았습니다** (저장소에 라이선스가 없습니다) |

Reflux 의 패치 대응 포크와 오프셋을 꾸준히 공개해 주시는 INF오소리(OhSorry-DP) 측에 진심으로 감사드립니다.
이 앱이 게임 패치 뒤에도 계속 동작할 수 있는 것은 그 덕분입니다.

## 라이선스

MIT. Reflux 는 각 저장소의 MIT 라이선스를 따릅니다.
