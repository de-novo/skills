# Canopy — 프로젝트별 병렬 작업을 한눈에

작성: 2026-09-07. 상태: 설계 제안. 첫 판(`5e38159`)은 자리 표와 문제 행까지 있다.
이 문서는 두 번째 판의 결정을 적는다. 운영 명세가 아니다. 구현이 들어가면
`infra/lib/canopy.mjs`와 `infra/lib/dryad.mjs`가 동작을, `skills/dryad/README.md`가
필드를 소유한다.

## 사람이 답을 얻어야 할 질문

한 화면에서, 프로젝트마다:

1. 지금 몇 개의 워크트리가 동시에 움직이는가. 자리인 것과 아닌 것 모두.
2. 각 워크트리에서 **무슨 일을** 하고 있는가. 작업 한 줄, 마지막 보고, 얼마나 됐는가.
3. 각 워크트리가 **어떤 스킬 동사**를 실제로 썼는가. plan, report, attach, destroy …
4. 각 워크트리가 **어떤 파일을** 고쳤는가. 커밋한 것과 아직 안 한 것.
5. 서로 **겹치는 파일**이 있는가. 병합 충돌은 합칠 때가 아니라 지금 보여야 한다.

첫 판은 1(자리만)·2(마지막 저널 한 줄)까지다. 3·4·5는 이음새가 없다.

## 원칙

- 캐노피는 읽기만 한다. 첫 판과 같다. 레지스트리 파일을 열지 않고 공개 CLI의
  JSON만 읽는다. 따라서 필요한 정보는 전부 **Dryad `status --json`이 내주는 필드**로
  먼저 정의한다. 캐노피 UI는 그 다음이다.
- 새 추적 장치를 만들지 않는다. 파일 변경은 git이 이미 안다. 스킬 사용은 자리에서
  실행된 CLI 동사이므로 CLI 자신이 저널에 적으면 된다. 둘 다 이미 있는 것에서 읽는다.
- 겹침은 계산해서 보여 주되 판단하지 않는다. "이 두 자리가 같은 파일을 고쳤다"까지.
  누가 먼저 합칠지, 누가 양보할지는 사람이다.

## 이음새 1: 자리에서 실행된 스킬 동사 → 저널 `cli` 이벤트

`DRYAD_ID`가 설정된 프로세스에서 카탈로그 CLI가 **상태를 바꾸는** 동사를 실행하면,
그 자리의 저널에 한 줄을 붙인다.

```yaml
- { at: …, actor: seat, event: cli, detail: "overlay attach w6 web --image de-novo-me/web:2c46dc9… --apply", exit: 0 }
```

- 남기는 동사: `overlay create|attach|detach|destroy|touch|prune --apply`,
  `dryad report`(이미 `report` 이벤트가 있으므로 중복 기록하지 않음), `setup`,
  `infra up|provision`. 읽기 동사(`status`, `seat`, `urls`, `validate`, `projects`,
  `canopy`)는 남기지 않는다. 폴링이 저널을 덮지 않게 하기 위해서다.
- `--image` 값과 인자는 그대로 적되 `GROVE_PROVISION_PASSWORD` 같은 환경변수는 애초에
  argv에 없다. passthrough(`--` 뒤)는 Grove 계약과 같이 SHA-256 요약만 적는다.
- 기록은 CLI 진입점(`cli.mjs`)에서 한 번, 명령이 끝난 뒤 종료 코드와 함께. 실패한
  attach도 남는다. 그것이 "무엇을 시도했는가"다.
- `DRYAD_ID`의 자리가 레지스트리에 없으면(이미 finish됨) 조용히 넘어간다. 기록
  실패가 명령 자체를 실패시키지 않는다.

이로써 "어떤 스킬을 썼는가"는 저널의 `event ∈ {plan, cli, report, finish…}`를 세는
것이 된다. 캐노피는 자리마다 동사별 개수와 마지막 시각을 보인다.

## 이음새 2: 파일 변경 → `status --json`의 `changes`

자리마다 git에서 읽는다. 새 상태는 없다.

```json
"changes": {
  "base": "879559a…",
  "committed": [ { "path": "apps/web/src/routes/work.$slug.tsx", "status": "M" }, … ],
  "uncommitted": [ { "path": "apps/web/src/components/work/x.tsx", "status": "??" } ],
  "counts": { "committed": 4, "uncommitted": 1, "ahead": 2 }
}
```

- `committed` = `git diff --name-status <base>..HEAD`, `uncommitted` = `git status --porcelain`.
- 수백 개를 넘으면 `truncated: true`와 함께 앞 200개만. 화면은 개수를 먼저 보인다.
- 워크트리가 없으면 `changes: null`. 입양한 워크트리도 같다.

## 이음새 3: 자리가 아닌 워크트리 → 프로젝트의 `worktrees`

`status --json` 최상위에 baseline의 `git worktree list --porcelain`을 붙인다.

```json
"worktrees": [
  { "path": "/…/de-novo-me", "branch": "main", "head": "73f9c01…", "seat": null, "baseline": true },
  { "path": "/…/workspaces/de-novo-me/dryad-w8", "branch": "…/dryad-w8", "head": "…", "seat": "w8", "baseline": false },
  { "path": "/…/somewhere/else", "branch": "feature/x", "head": "…", "seat": null, "baseline": false }
]
```

자리 없는 워크트리는 "누군가 병렬로 일하지만 Dryad는 모른다"는 뜻이다. 캐노피는
그것을 회색 열로 보인다. `changes`는 자리에만 계산한다. 자리 아닌 워크트리의 파일까지
읽는 것은 다른 사람 작업을 들여다보는 일이라 기본으로 하지 않는다.

## 이음새 4: 겹침 → `status --json`의 `overlaps`

프로젝트 수준. 같은 파일을 둘 이상의 자리가 `committed` 또는 `uncommitted`로 가진
경우.

```json
"overlaps": [ { "path": "apps/web/src/routes/work.$slug.tsx", "seats": ["w8", "w9"] } ]
```

이 값은 `status`의 종료 코드에 영향을 주지 않는다. 겹침은 문제가 아니라 사실이다.
텍스트 `status`에는 `overlaps n`을 한 줄로 센다.

## 화면

```
■ de-novo-me   seats 3 · worktrees 4 (1 unseated) · envs 2/2 · overlaps 1        Grove · pending 0 · drift 0
┌ w8 · claude · 36m ───────────┐ ┌ w9 · codex · 10m ────────────┐ ┌ (unseated) feature/x ──────┐
│ ASCII figures for the sheet  │ │ scroll-led reading motion    │ │ /Users/…/somewhere/else     │
│ ● done  "3 plates in SSR…"   │ │ ● done  "5 head states…"     │ │ HEAD 1a2b3c4 · main+3       │
│ env w8 tracked → web--w8…    │ │ env w9 tracked → web--w9…    │ │                             │
│ skills  plan 1 · attach 2 ·  │ │ skills  plan 1 · attach 1 ·  │ │                             │
│         report 4             │ │         report 3             │ │                             │
│ files   +3 committed · 0 open│ │ files   +5 committed · 0 open│ │                             │
│   work/ascii-figure.tsx      │ │   work/sheet-motion.tsx      │ │                             │
│   work/skills-figures.tsx    │ │   work/sheet-reading-head…   │ │                             │
│ ⚠ routes/work.$slug.tsx      │ │ ⚠ routes/work.$slug.tsx      │ │                             │
└──────────────────────────────┘ └──────────────────────────────┘ └─────────────────────────────┘
  ⚠ overlap  routes/work.$slug.tsx  w8 · w9
  ▸ finished 11
```

- 프로젝트 하나가 한 줄, 그 아래 워크트리마다 세로 카드. 카드 순서는 자리 → 자리 없는
  워크트리, 각각 최근 활동순.
- 카드 안: 작업 첫 줄, 상태와 마지막 보고, env와 hostname 링크, 스킬 동사 개수, 파일
  개수와 목록(겹치는 파일은 앞에 `⚠`), 경과 시간.
- 겹침은 카드 안에서 표시하고 프로젝트 아래에 한 번 더 모아 보인다.
- 첫 판의 문제 행, finished 접기, 5초 폴링, JS 없이 첫 렌더는 그대로 유지한다.
- 좁은 화면에서는 카드가 세로로 쌓인다. 파일 목록은 12개까지 보이고 나머지는 개수.

## 하지 않는 것

- 자리 아닌 워크트리의 파일 목록. 이유는 위.
- 도구의 세션 로그 열기. `session`은 여전히 링크 텍스트다.
- 작업 지시, 우편함, "다음 할 일". 캐노피는 보기만 한다.
- 겹침에 대한 판단이나 자동 rebase.

## 측정 계획

| 이음새 | 검사 |
| --- | --- |
| `cli` 이벤트 | 임시 자리에서 `DRYAD_ID`를 두고 `overlay create --apply`와 실패하는 `attach`를 실행 → 저널에 `cli` 2줄, exit 0과 1. `status`는 남지 않음. finish된 자리에서 실행해도 명령은 성공 |
| `changes` | 실제 임시 저장소에서 커밋 2개와 미커밋 1개 → committed 2, uncommitted 1, ahead 2. 200개 초과에서 `truncated` |
| `worktrees` | baseline 옆에 `git worktree add`로 자리 아닌 워크트리 하나 → `seat: null` 1, baseline 1 |
| `overlaps` | 두 자리가 같은 파일을 고침 → overlaps 1, 종료 코드 그대로 |
| 캐노피 | `--once`가 위 필드를 그대로 싣는다. 소켓으로 `/`를 받아 `⚠` 와 카드 수를 센다 |

가드마다 되돌려 red를 본다. 실제 도구로는 도그푸딩 자리로 한 번 더 돈다.

## 실린 것

- **2026-09-07, 데이터 자리(d1).** 이음새 1~4와 `hostnames` 수정이
  `infra/lib/dryad.mjs`·`infra/bin/cli.mjs`에 들어갔다. `DRYAD_ID`가 있는
  프로세스가 상태를 바꾸는 동사(`overlay …--apply`, `setup`, `infra
  up|provision`)를 실행하면 CLI 진입점이 종료 코드와 함께 `cli` 저널 한 줄을
  붙인다(읽기 동사는 남기지 않고, `--` 뒤는 SHA-256 요약만). `status --json`은
  자리마다 `changes`(200개 초과 시 `truncated`, 개수는 온전)와 자리 없는
  워크트리까지 포함한 최상위 `worktrees`, 그리고 종료 코드를 바꾸지 않는
  `overlaps`를 싣는다. `hostnames`는 `[{host, service, attached}]`가 되어 붙지
  않은 서비스를 구분한다. 필드는 `skills/dryad/README.md`가 소유한다. 잰 것:
  `node --test infra/bin/dryad.test.mjs` 18/18, `npm test` 214/214(전 210),
  새 가드 5개를 각각 되돌려 red 5/5. 화면(카드)은 아직 없다.

## 자리 나누기

- 카탈로그 자리 하나(데이터): 이음새 1~4를 `dryad.mjs`/`cli.mjs`에, 테스트, README 필드 표.
- 카탈로그 자리 하나(화면): 위 JSON 형태를 지시서로 받아 fixture에 대고 카드 화면.
  이전 판과 같은 방식으로 병렬.
- 두 자리가 끝나면 사이트에 자리 둘을 다시 열어 겹침이 실제로 보이는지 캐노피로
  본다. 그 캡처가 이 판의 증거다.
