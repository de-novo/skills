# Dryad — 나무 위의 자리

작성: 2026-09-06. 상태: 설계 기록. 같은 날 구현됨. 설계 기준: `69418fc`.
이 문서는 운영 명세가 아니다. 패턴은 [`skills/dryad/SKILL.md`](../skills/dryad/SKILL.md),
스키마·레지스트리·CLI는 [`skills/dryad/README.md`](../skills/dryad/README.md),
검사는 `infra/lib/dryad.mjs`가 소유한다. 이 문서는 결정의 이유만 남긴다.
구현이 설계와 다른 점: 레지스트리는 `GROVE_STATE_DIR` 아래에서도 `dryads/`
하위로 들어가 Grove 파일과 겹치지 않는다. `report`의 `--session`은 자리의
값을 덮어쓴다. `status`는 Grove `overlay status`의 env 줄을 읽어 추적 여부를
센다.

## 한 문장

Grove는 땅이다. Dryad는 그 땅의 나무(워크트리) 한 그루에 작업자 한 명이 앉을
**자리**를 만들고, 몇 자리에 누가 앉아 무엇을 했는지 세고, 일이 끝나면 자리를
비운다. 어느 자리에 어느 작업자를 앉힐지, 어떤 도구로 앉힐지는 사람이 정한다.
Dryad는 작업자를 띄우지 않는다.

## 경계

| 질문 | 소유자 |
| --- | --- |
| 이름, 엔진, overlay env, lease, 반영 판정 | Grove |
| 자리(워크트리 + env + 작업 본문) 생성·등록·정리, 자리 수와 이력 | Dryad |
| 어떤 작업을 어느 자리에, 어떤 도구로 | 사람 |
| 에이전트 프로세스 실행, 대화 이어가기, 유휴·권한 감지 | 런처(터미널, 워크트리 관리 앱, tmux, ACP 클라이언트 등). Dryad 밖 |
| 작업 DAG, 감독 루프, 우편함, 에스컬레이션 | 오케스트레이터. Dryad 밖 |
| 브랜치 병합, 푸시, 리뷰 | 사람과 프로젝트. Dryad는 하지 않는다 |
| 브라우저 QA, e2e | 프로젝트. 두 스킬 모두 밖 |

의존은 한 방향이다. Dryad는 Grove를 쓴다. Grove는 Dryad를 모르고, Dryad 없이
그대로 동작한다. 반대로 `overlay: none`인 프로젝트에서도 Dryad는 워크트리만으로
동작해야 한다. claude 단일 환경은 자리마다 같은 런처를 쓰는 경우일 뿐 별도
모드가 아니다.

Grove와의 접점은 공개 CLI 세 개뿐이다. `de-novo skills overlay create/destroy/status`,
`urls`, `validate`. `infra/lib/overlay.mjs`를 import하지 않는다. 사람이 손으로
치는 경로와 Dryad가 밟는 경로가 같아야 한 경계에서 잰 결과가 양쪽에 유효하다.
자기 자신을 자식 프로세스로 띄우는 비용은 받아들인다.

## 왜 Dryad가 에이전트를 띄우지 않는가

2026-09-06에 두 워크트리 관리 앱의 소스와 ACP·각 CLI의 공식 문서를 확인했다.
요약은 [참고한 도구](#참고한-도구)에 있다. 결론은 셋이다.

- 에이전트를 띄우는 방식은 도구마다 다르고 빠르게 바뀐다. PTY에 TUI를 앉히는
  방식, 도구별 네이티브 프로토콜, ACP 단일 프로토콜 중 어느 것도 작은 CLI가
  소유할 크기가 아니다.
- `claude -p` 같은 단발 헤드리스 실행은 대화를 이어갈 수 없고, 세션이 끝나도
  살아 있는 대화형 도구의 완료를 프로세스 종료로 오판한다. 확인한 앱 둘 다
  종료 코드를 완료 신호로 쓰지 않는다.
- 확인한 앱 둘 다 워크트리를 자기가 만든다. Dryad가 워크트리 생성을 독점하면
  이 도구들과 싸운다.

그래서 Dryad의 산출물은 **자리(seat)** 다. 자리는 런처가 무엇이든 그대로 넘길 수
있는 값 묶음이고, 런처는 값도 아니고 Dryad 밖이다.

## 어휘

- **자리(seat)**: 워크트리 하나 + (overlay가 있으면) overlay env 하나 + 작업
  본문 + `DRYAD_*` 환경변수. id는 DNS 라벨이며 overlay env 이름과 같다. Grove
  레지스트리와 Dryad 레지스트리가 같은 키로 만난다.
- **dryad**: 자리에 앉은 작업자. 사람일 수도, 어떤 도구로 띄운 에이전트일 수도
  있다. Dryad는 누가 앉았는지 이름표(`--by`)만 적는다.
- **런처(launcher)**: 자리를 받아 작업자를 앉히는 것. 터미널에서 사람이 `cd`하고
  도구를 여는 것도 런처다.
- **저널(journal)**: 자리마다 시간순으로 쌓이는 줄. Dryad가 한 일과 작업자가
  보고한 것. 덮어쓰지 않는다.
- **baseline checkout**: 프로젝트를 clone한 원래 디렉터리. 자리는 여기에 만들지
  않는다. Grove의 "agent worktree에서 baseline을 띄우지 말라"와 같은 선이다.

## 값 파일

`.agents/dryad-profile.yml`, 프로젝트 저장소에 커밋한다. `runtime-profile.yml`의
top-level 키 화이트리스트는 불변식이므로 거기에 얹지 않는다. 별도 파일,
별도 파서. 허용 top-level 키는 `version` `worktrees` 둘이다. 그 외는 거부한다.

```yaml
version: 1                       # 생략 = 1. 다른 값은 거부
worktrees:
  root: ../<slug>-dryads         # Dryad가 만들 때의 위치. baseline 기준 상대경로, 저장소 밖이어야 함
  branch: "dryad/{id}"           # 자리표시자는 {id}만 허용. 결과는 유효한 git ref
```

값이 이것뿐인 이유는 런처가 밖이기 때문이다. 어떤 도구를 어떤 플래그로 띄울지는
런처의 설정이지 Dryad의 값이 아니다. 자리를 입양만 하는 프로젝트는 `worktrees`
자체를 생략할 수 있고, 그때 `plan`은 `--worktree` 없이는 거부한다.

`root`가 baseline checkout 안을 가리키면 거부한다. 워크트리가 저장소 안에 생기면
baseline의 git status를 더럽히고 작업자가 다른 자리를 밟기 쉽다.

## 레지스트리

`~/.dev-infra/dryads/<slug>.yml`. Grove overlay 레지스트리와 같은 디렉터리
규칙(`GROVE_STATE_DIR` 존중, 임시 파일 rename, private 권한, 짧은 read/merge/write
락). 자격증명은 두지 않는다.

```yaml
version: 1
project: acme
seats:
  w1:
    worktree: /Users/me/acme-dryads/w1
    owned: true                  # false = 입양. finish가 워크트리를 지우지 않음
    branch: dryad/w1
    base: 0123456789abcdef0123456789abcdef01234567
    task: |
      billing API에 환불 엔드포인트 추가
    env: w1                      # null = 프로파일이 overlay: none
    by: claude                   # 사람이 준 이름표. 검증하지 않음
    session: null                # report --session 으로 채움. 도구의 세션 id나 로그 경로
    created_at: 2026-09-06T02:10:00Z
    status: working              # 마지막 report. planned|working|blocked|done
    journal:
      - { at: 2026-09-06T02:10:00Z, actor: dryad, event: plan, detail: "worktree add dryad/w1 at 0123456" }
      - { at: 2026-09-06T02:10:04Z, actor: dryad, event: overlay.create, detail: "ok env w1" }
      - { at: 2026-09-06T02:31:12Z, actor: seat,  event: report, detail: "working" }
      - { at: 2026-09-06T03:02:40Z, actor: seat,  event: report, detail: "blocked: 결제 mock 응답이 스키마와 다름" }
```

`journal`은 append-only다. `actor: dryad`는 Dryad가 한 일, `actor: seat`는
작업자가 `report`로 보고한 것이다. `status`는 마지막 report의 요약일 뿐이고
이력은 저널이 소유한다.

레지스트리는 상태의 거울이지 컨트롤러가 아니다. 워크트리가 사라졌거나 env가
어긋났으면 `status`가 그 사실을 세어 보고한다. 조용히 고치지 않는다.

## 무엇이 추적되고 무엇이 안 되는가

| 질문 | 답이 있는 곳 |
| --- | --- |
| 어느 워크트리, 어느 브랜치, 어느 base에서 시작했나 | 자리 항목 |
| 무슨 작업을 받았나, 누가 앉았나 | `task`, `by` |
| 코드를 무엇을 바꿨나 | 브랜치의 커밋. `git log <base>..dryad/w1` |
| 공유 환경에 무엇을 붙였다 뗐나 | Grove overlay 레지스트리. env마다 mutation, 이미지, 시각, 만든 워크트리 |
| 언제 무슨 상태를 거쳤나 | 저널 |
| 도구 안에서 정확히 무슨 일이 있었나 | `session`이 가리키는 도구의 네이티브 로그. Dryad는 열지 않는다 |

남지 않는 것: 작업자가 실행한 명령과 읽은 파일의 순서(도구 로그의 일), 워크트리
밖에서 한 일(공유 DB 직접 쓰기 등. Grove 규칙이 금지하지만 감시하지 않는다).
행동 하나하나를 보려면 PTY나 훅이 필요하고 그것은 런처의 일이다.

## CLI

```text
de-novo skills dryad plan   <id> (--task <text> | --task-file <path>) [--worktree <existing-path>] [--by <label>] [--project <root>] [--apply]
de-novo skills dryad seat   <id> [--json | --env | --shell] [--project <root>]
de-novo skills dryad report <id> --status <working|blocked|done> [--note <text>] [--session <ref>] [--project <root>]
de-novo skills dryad status [id] [--project <root>] [--json]
de-novo skills dryad finish <id> [--project <root>] [--apply]
```

`--project`를 생략하면 cwd에서 위로 올라가며 `.agents/dryad-profile.yml`을 찾는다.
작업자가 워크트리 안에서 부르면 워크트리의 `.agents/`가 잡히므로 baseline
경로는 `DRYAD_PROJECT`로 넘긴다. 레지스트리 slug는 그 baseline의
`runtime-profile.yml` `project.slug`에서 읽는다. Dryad 프로파일에는 slug가 없다.
두 집에 같은 사실을 두지 않기 위해서다.

### plan

`--apply` 없이: 만들 워크트리 경로, 브랜치, base 커밋, env 유무를 출력한다.
아무것도 만들지 않는다.

`--apply`, 순서대로:

1. id가 DNS 라벨이고 레지스트리에 없으며 overlay env로도 추적되지 않는지 확인.
2. 워크트리.
   - `--worktree` 없음: `worktrees`가 프로파일에 있어야 한다. 대상 경로가 비어
     있어야 한다. baseline에서 `git worktree add --no-track -b <branch> <path> HEAD`.
     `owned: true`. base는 그 HEAD.
   - `--worktree <path>`: 경로가 존재하고, `git rev-parse --git-common-dir`이
     baseline의 것과 같고, baseline 자신이 아니어야 한다. 브랜치와 HEAD를 읽어
     그대로 적는다. `owned: false`. 워크트리를 만들지도 바꾸지도 않는다.
3. runtime-profile에 overlay가 있으면 `de-novo skills overlay create <id> --apply --project <baseline>`.
   종료 코드와 마지막 JSON 줄을 저널에 적는다. 실패하면 자리를 `env: pending`
   으로 남기고 종료 코드 1. 만들어진 워크트리는 지우지 않는다.
4. 자리를 기록하고 `status: planned`, 저널에 `plan`.

같은 인자로 `plan --apply`를 다시 부르면 이미 된 단계는 건너뛰고 남은 단계만
한다. 워크트리가 이미 그 브랜치로 있으면 통과, env가 `pending`이면 3번만 다시.
Grove의 pending 복구와 같은 모양이다.

### seat

레지스트리에서 자리를 읽어 출력한다. 워크트리 존재를 확인하고 없으면 종료 코드
1과 함께 그래도 출력한다. 사람이 왜 없는지 보러 갈 수 있어야 한다.

- `--json`: `{ id, project, worktree, branch, base, env, task, by, env_vars: {...} }`
- `--env`: `DRYAD_ID=w1` 식 넉 줄
- `--shell`: `cd '<worktree>' && export DRYAD_ID='w1' DRYAD_ENV='w1' DRYAD_BRANCH='dryad/w1' DRYAD_PROJECT='<baseline>'` 한 줄. 값은 단일 인용으로 감싸고 인용부호는 이스케이프한다.

`DRYAD_ENV`는 env가 없으면 빈 문자열이다. 작업 본문은 환경변수에 넣지 않는다.
길이 제한과 셸 인용 문제 때문이다.

### report

`status`를 갱신하고 저널에 `report` 줄을 붙인다. `--note`는 그대로, `--session`은
자리의 `session`을 덮어쓴다. 검증은 status 값과 자리 존재뿐이다. `done` 뒤에
`working`을 보내도 막지 않는다. 사람이 다시 앉힐 수 있어야 한다.

### status

인자 없이: 프로젝트 전체를 센다.

```text
■ acme — seats 3
  worktrees  3/3 present
  envs       2/2 tracked (w3: overlay none)
  reported   done 1, working 1, blocked 1
  w1  dryad/w1  +12  env w1 ready    done      by claude
  w2  dryad/w2  +3   env w2 ready    working   by codex
  w3  dryad/w3  0    -               blocked   by human   "orders 스키마 결정 필요"
```

`envs`는 `de-novo skills overlay status --project <baseline>`을 한 번 불러 그
결과와 자리를 대조한 값이다. `+12`는 `git rev-list --count <base>..HEAD`다.

`status <id>`: 위 한 줄에 더해 저널을 시간순으로 전부 출력한다.

종료 코드는 1이 되는 조건이 넷이다. 워크트리가 없는 자리가 있다. env가 있어야
할 자리가 overlay status에 없거나 그 반대다. overlay status 자체가 non-zero다.
`blocked`인 자리가 있다. 어느 것도 `--json`에서는 `problems` 배열로 나온다.

### finish

`--apply` 없이: destroy할 env, 지울 워크트리(owned일 때만), 남는 브랜치를
출력한다.

`--apply`, 순서대로:

1. env가 있으면 `de-novo skills overlay destroy <id> --apply --project <baseline>`.
   실패하면 저널에 적고 멈춘다. 자리는 남는다. 종료 코드 1.
2. `owned: true`이고 워크트리가 깨끗하면(`git status --porcelain` 빈 출력)
   `git worktree remove <path>`. 더러우면 저널에 적고 멈춘다. 자리는 남는다.
   종료 코드 1. `--force`는 없다.
3. `owned: false`면 워크트리를 건드리지 않는다.
4. 자리를 레지스트리에서 지운다. 브랜치는 남는다.

레지스트리에서 지우면 저널도 사라진다. 이력을 남기고 싶으면 finish 전에
`status <id>`를 파일로 받는다. Dryad는 보관소가 아니다.

## 자리를 런처에 넘기는 예

Dryad는 아래 어느 것도 실행하지 않는다. 사람이나 오케스트레이터가 한다.

```bash
# 터미널에서 사람이 직접
eval "$(de-novo skills dryad seat w1 --shell)" && claude

# 워크트리를 먼저 만드는 런처: 그 워크트리를 입양
de-novo skills dryad plan w2 --worktree <launcher-created-path> --task-file tasks/w2.md --by codex --apply

# 스크립트: seat JSON을 읽어 원하는 도구로
de-novo skills dryad seat w3 --json | my-launcher --stdin
```

## 작업자가 깨어났을 때

작업자는 어떤 런처로든 워크트리를 cwd로, `DRYAD_*` 환경변수를 가지고 시작한다.
작업 본문은 첫 프롬프트로 들어가므로 워크트리 안에 파일을 쓰지 않는다. git
status가 깨끗하게 시작해야 작업자의 변경만 남는다.

`skills/dryad/SKILL.md` 개요:

```text
frontmatter  name: dryad, description: 트리거는 DRYAD_ID 존재, /dryad, "자리", "seat"
# Dryad
한 문장. 이 파일이 패턴을 소유하고 값은 .agents/dryad-profile.yml.
## You are a dryad when
DRYAD_ID가 있을 때. seat --json으로 자기 자리를 읽는다. 없으면 이 절은 무시.
## Rules
1. 자기 워크트리 밖을 바꾸지 않는다. baseline, 다른 자리 모두.
2. 검증은 /grove 절차. env는 이미 있다. attach는 당신, destroy는 finish.
3. 막히면 report blocked --note. 진행 중 큰 전환마다 report working --note.
4. 끝나면 커밋, report done, 멈춤. 푸시·병합·finish는 사람.
5. 도구가 세션 id나 로그 경로를 주면 report --session으로 남긴다.
## Seating others (사람 또는 오케스트레이터가 읽는 절)
plan → 런처로 넘김 → status로 셈 → finish. 각 명령 한 줄과 링크.
## Not this skill
런처, 우편함, DAG, 병합.
```

완료는 작업자의 자기 보고다. 도구를 가리지 않고, PTY 파싱도 훅도 필요 없다.
도구의 훅이나 런처의 완료 이벤트에 `report done`을 걸어 두는 것은 프로젝트나
런처의 선택이며 Dryad가 요구하지 않는다.

## 불변식 후보

구현 전 확정할 것. 값은 바뀌어도 이것은 바뀌지 않는다.

- 자리 하나에 워크트리 하나. baseline checkout에는 자리를 만들지 않는다.
- Dryad는 에이전트 프로세스를 띄우지 않는다. 런처는 밖이다.
- 더러운 워크트리는 지우지 않는다. 입양한 워크트리는 지우지 않는다. 브랜치는
  지우지 않는다.
- 완료는 작업자의 보고이지 프로세스 종료가 아니다.
- 저널은 덮어쓰지 않는다.
- Grove는 공개 CLI로만 부른다.
- 병합, 푸시, 리뷰를 하지 않는다.
- 성공은 센 것이다. `seats n`, `worktrees n/n`, `envs n/n`, `reported …`.

## Grove 쪽 선행 조건

2026-09-05 [워크트리 실험](evaluation/2026-09-05-worktree-evaluation.md)이 짚은
문제가 그대로 남아 있다. 다른 자리가 정상 진행 중인 overlay 작업과, 중단되어
복구가 필요한 작업이 호출자에게 같은 복구 요구로 보인다. 두 자리가 동시에
attach하는 순간 이 문제를 만난다. Dryad는 이 구분을 Grove가 제공한다고
전제하고 설계한다. Grove 집에서 먼저 고치고 재야 두 자리 동시 검증이 잰 것이 된다.
plan/seat/report/status/finish는 이 문제와 무관하게 잴 수 있다.

## 측정 계획

`infra/bin/dryad.test.mjs`. 임시 git 저장소를 baseline으로, `GROVE_STATE_DIR`을
임시 디렉터리로, overlay 명령은 Grove의 process-workload fixture로.

| 검사 | 세는 것 |
| --- | --- |
| 프로파일 파서: 허용 키, `{id}` 외 자리표시자 거부, root가 저장소 안이면 거부 | 거부 n/n |
| plan 없이 `--apply`: 아무 부작용 없음 | 워크트리 0, 레지스트리 없음 |
| plan `--apply` 생성 경로 | 워크트리 1/1, 브랜치, base = HEAD, env 1/1(overlay 있는 프로파일), 저널 2줄 |
| plan `--apply` 입양 경로 | 워크트리 만들지 않음, `owned: false`, 다른 저장소의 경로는 거부, baseline 자신은 거부 |
| plan 재실행: overlay create 실패 후 다시 | 첫 실행 env pending, 두 번째 실행 env 추적 1/1, 워크트리는 그대로 |
| seat 세 형태 | `--json` 필드, `--env` 넉 줄, `--shell`을 실제 `sh -c`로 실행해 cwd와 환경변수가 fixture 프로세스에 도달 |
| report | status 갱신, 저널 append, session 저장 |
| status 종료 코드 넷 | 워크트리 삭제 후 1, env 어긋남 후 1, blocked 후 1, 정상 0 |
| finish 생성 경로 | destroy 호출 1/1, 깨끗하면 워크트리 0, 더러우면 남고 종료 1, 브랜치 존재 |
| finish 입양 경로 | 워크트리 그대로, 자리만 제거 |
| 두 자리 동시 plan `--apply` | 워크트리 2/2, env 2/2, 레지스트리에 둘 다 |

"런처에 넘긴다"는 경계는 `--shell` 검사가 잰다. 실제 도구(claude, codex 등)를
띄우는 것은 Dryad 밖이므로 `notMeasured`가 아니라 범위 밖이다. 워크트리 실험
하네스를 자리 두 개로 확장해 동시 검증을 재는 것은 Grove 선행 조건이 풀린 뒤다.

새 가드마다 프로덕션 변경을 되돌려 테스트가 빨개지는 것을 보고 복구한다.
빨개진 수를 PR에 적는다.

## 구현 순서

1. `infra/lib/dryad.mjs`: 프로파일 파서와 레지스트리 read/merge/write. 테스트.
2. `plan`(둘 다 경로), `seat`, `report`, `status`. CLI 동사 연결. 테스트.
3. `finish`. 테스트.
4. `skills/dryad/SKILL.md`, `README.md`, `examples/`, `.agents/skills/dryad`
   심링크, 루트 README 행. catalog 절차대로.
5. Grove 선행 조건 해결 후 동시 검증 하네스.

각 단계가 PR 하나다. PR 설명에 후보 SHA, 실행한 명령, 센 결과, 빨개진 테스트
수를 적는다.

## 두 번째 판에서 고려할 것

seat 계약이 굳은 뒤에만 본다. 첫 판에는 없다.

- **ACP 클라이언트 내장.** 문서화된 공통 기계 인터페이스는 ACP뿐이다. 내장
  런처가 필요해지면 `session/new`, `session/prompt`, `session/request_permission`을
  다루는 얇은 클라이언트 하나로 여러 도구를 덮을 수 있다. `-p`도 PTY도 아니다.
  런처 argv는 그때 값이 된다.
- **저널 보관.** finish가 저널을 지우는 것이 아까워지면 `finish --archive <dir>`
  로 파일을 남기는 것을 본다. 지금은 `status <id>` 리다이렉트로 충분하다.
- **감독 우편함.** `worker_done`·`ask`·`escalation` 같은 것은 오케스트레이터의
  일이다. Dryad `report`는 그 축소판이 아니라 자리의 마지막 상태 한 줄이다.

## 참고한 도구

2026-09-06 확인. 워크트리 관리 앱 둘은 소스를, 나머지는 공식 문서를 봤다.

| 방식 | 대표 | 후속 메시지 | 유휴·완료 감지 | 워크트리 |
| --- | --- | --- | --- | --- |
| PTY에 셸을 띄우고 startup 명령으로 TUI 실행 | 데스크톱 워크트리 관리 앱 A, Claude Squad, Superset | PTY에 텍스트와 Enter 기록 | 훅이 로컬 HTTP로 `working/blocked/waiting/done` 보고, 폴백은 터미널 제목·화면 정규식 | 앱이 자체 경로에 생성·제거 |
| 도구별 네이티브 프로토콜 | 데몬형 워크트리 관리 앱 B (Claude는 Agent SDK `query()`, Codex는 `app-server` JSON-RPC, OpenCode는 `serve` HTTP, 나머지는 ACP), Symphony | 살아 있는 세션에 push | 프로토콜 이벤트 `turn_completed`, 권한 요청은 UI로 | 앱이 자체 경로에 생성·제거 |
| ACP 단일 프로토콜 | Emdash, Zed, JetBrains | ACP `session/prompt` | ACP stop reason | 작업당 워크트리 |

ACP 커버리지: Claude Code(`claude-agent-acp`), Codex(`codex-acp`), Gemini
(`--experimental-acp`), OpenCode(`opencode acp`), Cursor(`cursor-agent acp`),
Grok(`grok agent stdio`). 클라이언트는 Zed, JetBrains, Neovim, Emacs 등.

## 이름

npm `dryad`는 0.0.0에서 멈춘 패키지이고 Microsoft Research Dryad는 보관된
데이터 병렬 연구다(2026-09-06 확인). 이 스킬은 npm 패키지가 아니며 CLI는
`de-novo skills dryad`이므로 충돌하지 않는다.

## 하지 않는 것

- 에이전트 프로세스 실행, PTY, 화면 파싱, 훅 설치.
- 스케줄러, 큐, 우선순위, DAG, 우편함. 사람이 plan을 부르는 순서가 순서다.
- 자동 병합, 충돌 해결, PR 생성.
- Grove 내부 모듈 import.
- `runtime-profile.yml`에 키 추가. Dryad 프로파일에 slug 중복.
