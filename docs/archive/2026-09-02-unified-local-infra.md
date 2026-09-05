> Archived on 2026-09-05. Historical design only; commands and assumptions
> below may be obsolete or unimplemented. Do not use as operating instructions.
> Current authority: [documentation index](../README.md).

# Grove unified local infra (design notes)

Written in Korean during the original design loop. Current English docs:
`skills/grove/README.md`, `skills/grove/SKILL.md`, `infra/README.md`.
Command names in current English docs use `de-novo skills`. This design
file still says `de-novo-skills` in many places — same CLI.

Shipped product: engines, profile, `urls` (prints names), and the overlay
lifecycle dispatcher/lease registry. No Caddy or `proxy up`; overlay workloads
and routing remain project commands. This file is design.

Addressing is **in-repo yaml**, not `~/.dev-infra/config.yml`. This checkout:
`infra/addressing.yml` (+ gitignored `infra/addressing.local.yml`). A consuming
project: `.agents/runtime-profile.yml` (+ `.agents/runtime-profile.local.yml`).

# Original title: 통합 로컬 개발 인프라

| 항목 | 값 |
| --- | --- |
| 문서 | dev-infra 통합 로컬 개발 인프라 설계 |
| 저자 | TBD |
| 날짜 | 2026-09-02 |
| 상태 | Draft |
| 대상 저장소 | `/Users/denovo/orca/denovo/dev-infra` |

이 문서는 구현하지 않는다. 엔지니어가 이 문서만으로 구현할 수 있게 쓴다.

---

## Overview

한 머신에서 여러 프로젝트와 여러 AI 에이전트가 동시에 개발하면 두 가지가 깨진다. 첫째, 프로젝트·에이전트마다 스택을 띄워 3000·8080을 쟁탈하고 CORS·OAuth 리다이렉트가 무너지며 "지금 API가 어느 포트인지"에 답이 없어진다. 둘째, 에이전트가 각자 자기 변경을 열어 보고 싶은데 풀스택을 복제하면 포트가 터지고, 한 스택을 공유하면 서로의 배포를 덮어쓴다.

dev-infra는 이미 머신 공유 엔진 층(MySQL·PG·Redis·Kafka·Mongo·Mail·MinIO)을 갖고 있다. 이 설계는 그 위에 **프로젝트 무관한 주소 층(와일드카드 TLD + 선택적 루프백 프록시)** 과 **오버레이 라우팅 제어면(레지스트리 + 호스트네임 폴스루)** 을 같은 CLI(`de-novo-skills`)에 얹어, 개발자·에이전트에게 **이름 붙은 URL과 그 URL이 가리키는 스택**을 준다. 앱 compose/k8s 매니페스트, 이미지 빌드, 확인 도구(curl·브라우저·테스트 러너)는 소비 프로젝트가 계속 소유한다. 머신 프록시 리스너는 옵트인이다 (`addressing.proxy: machine`). 생략 기본값은 `none` — URL만 인쇄하고 `:80`을 건드리지 않는다.

---

## Background & Motivation

### 설계 당시 구현 (역사 기록; 현재 제품 명세 아님)

`de-novo-skills`의 이빨은 **엔진 층만** 있다.

- `infra/docker-compose.yml` — 엔진 한 벌, 전부 `127.0.0.1`에 표준 포트, 네트워크 이름 `dev-infra`. `restart: unless-stopped`.
- `infra/bin/cli.mjs` — `setup | up | status | provision`. **`down`은 없다** (여러 프로젝트가 엔진 위에 산다).
- `infra/bin/setup.mjs` `readProfile`이 실제로 읽는 키: `project.slug`, `project.namespace`, `data.infra`, `data.engines`. `single_stack`, `writers`, `services`, `addressing`, `overlay`, `runtime.commands`는 파싱·검증하지 않는다. `project.slug` 패턴은 `^[a-z][a-z0-9_-]*$` (`NS_PATTERN`) — 밑줄 허용. DNS 라벨은 밑줄을 허용하지 않는다.
- 모르는 엔진은 거절한다 (`ENGINES` 표 + `ALIASES`). `data.infra !== "machine"` 이면 거절한다.
- 성공 판정은 종료코드가 아니라 센 결과물이다 (`엔진 2/2`, `DB n/n`). `cmdUp` / `runSetup`이 이미 이 패턴이다.
- `infra/bin/provision` — mysql/pg database + 전용 계정, 멱등.
- `package.json` `bin.de-novo-skills` → `infra/bin/cli.mjs`. 테스트는 `node --test infra/bin/`. 파일 락 헬퍼 의존성 없음.

스킬 `skills/grove/`은 네 기둥 운영 모델을 **제품 언어**로 적고 있다. 소프트웨어로 구현된 것은 기둥 1의 엔진 절반뿐이다.

| 기둥 | 스킬이 말하는 것 | 오늘 코드 |
| --- | --- | --- |
| 1. 장수 baseline | 머신 엔진 하나 + 프로젝트당 앱 baseline 하나 | 엔진만. 앱 baseline 기동은 프로젝트 `runtime.commands.up` |
| 2. 얇은 overlay | create/attach/detach/destroy, 바꾼 서비스만 | 없음. 멀티서비스 예시는 허구의 `node tools/dev-overlay.mjs` |
| 3. 호스트네임 폴스루 | `{service}.{tld}` / `{service}--{env}.{tld}` | 문서의 선택지(portless/traefik/caddy)만. 프록시·DNS 없음 |
| 4. 쓰기 단일 소유 | `writers: 1` | 프로파일 필드일 뿐. 발견 절차 없음 |

스킬 로드 경로도 비어 있다. 정본은 `skills/grove/`인데 Grok/Claude는 여기를 자동 로드하지 않는다. 확인된 로드 경로: `.agents/skills/`, `.claude/skills/`, `~/.agents/skills/`, `~/.claude/skills/`. `.grok/skills/` 와 `~/.grok/skills/` 는 이 대화의 전제이며 **이 체크아웃에서 검증되지 않았다** — 설치 명령은 디렉터리가 있을 때만 심고, 없으면 `--force` 없이 만들지 않는다.

루트 README는 symlink 어댑터를 설명하지만 이 레포에는 어댑터도 `de-novo-skills skill install`도 없다.

검증된 선행 구현은 소비 프로젝트 쪽에 있다. `onedns-microservice`의 `tools/dev-overlay.mjs`는 k3d Gateway API로 `{app}--{env}.local.fulgo.co.kr` 폴스루를 이미 구현하고 (`buildHostRoutes`: 붙지 않은 env 호스트는 shared namespace), `--apply` plan-first이며, `.claude/skills/*`는 `.agents/skills/*`로의 **상대** symlink다. 같은 머신의 `configs/local-k8s/k3d.yaml`은 호스트 `80:80`과 `443:443`을 로드밸런서에 붙인다. `infra/registry.local.md`는 이 머신에 fulgo/onedns가 산다고 적는다. 이 설계는 그 패턴을 프로젝트 무관 층으로 일반화한다. onedns compose/k8s를 이 레포로 가져오지 않는다.

### 통증

1. **포트 쟁탈.** 앱이 호스트 포트를 고르게 두면 프로젝트 수 × 에이전트 수만큼 충돌한다. 엔진은 이미 표준 포트 + 내부 분리(database·계정·프리픽스)로 이 문제를 풀었다. 앱 층은 아직 안 풀렸다.
2. **병렬 확인.** N개 풀스택은 포트와 RAM을 폭발시킨다. 한 스택 공유는 배포를 덮어쓴다. 해법은 바꾼 서비스만 얹고 나머지는 baseline으로 폴스루시키는 것 — **사용자·에이전트가 고르는 주소는 호스트네임**이다. 호스트 bind가 늘어나지 않는 것은 overlay 명령이 docker 네트워크 업스트림(`docker:<name>:<port>`, 호스트 publish 없음) 또는 k3d ClusterIP를 쓸 때뿐이다. 머신 Caddy가 `127.0.0.1:18002` 같은 추가 호스트 포트를 업스트림으로 받으면 N overlay는 여전히 N bind다. L1+L2가 그 자체로 호스트 포트를 없앤다고 말하지 않는다.

확인을 **어떻게** 하는지는 이 시스템의 범위가 아니다. 주는 것은 이름 붙은 주소와 그 주소가 가리키는 스택이다.

---

## Goals & Non-Goals

### Goals

- 한 개발자 Mac에서 여러 프로젝트·여러 에이전트가 **포트를 고르지 않고** 이름으로 서비스를 가리킨다 (`de-novo-skills urls`). 그 이름을 실제로 열 리스너는 옵트인이다.
- 오버레이가 켜진 프로젝트에서 N 에이전트가 **풀스택 N벌 없이** 자기 변경 URL을 갖는다. 붙이지 않은 `{service}--{env}`는 공유 baseline으로 폴스루한다.
- 호스트 포트 증가를 피하려면 overlay 계약이 docker 네트워크 또는 클러스터 내부 업스트림을 쓰게 한다. 제네릭 compose 헬퍼는 1차가 아니다.
- 프로젝트 무관한 것은 이 레포가 소유한다: 엔진, 머신 TLD, 루프백 프록시, 오버레이 **라우팅** 레지스트리, 프로파일 불변식 검증, writer 락, 스킬 로드 경로 어댑터.
- 패턴과 값을 섞지 않는다. 패턴·엔진은 여기, 값은 각 프로젝트 `.agents/runtime-profile.yml`.
- YAML이 정본이고 CLI는 그린다. 새 엔진 = compose + `ENGINES` 표 + 프로파일 선언 + `setup` 재실행.
- 성공은 센 결과물이다. 종료코드 0만으로 성공이라고 하지 않는다.
- 사실당 집 하나. 같은 불변식을 스킬·스키마·infra README·CLI help에 반복하지 않는다.
- 기존 `de-novo-skills`를 확장한다. 두 번째 CLI를 만들지 않는다. `down`을 추가하지 않는다.

### Non-Goals

- 브라우저 QA, ego-browser, e2e 러너, 클릭 절차, `qa:` 블록, `auth_file`.
- 확인 방법 처방 (curl vs 브라우저 vs 테스트 러너).
- 소비 프로젝트의 앱 compose/k8s 매니페스트를 이 레포로 이전.
- 프로덕션 멀티테넌트 컨트롤 플레인, 장기 실행 Kubernetes controller, 자동 affected-service 탐지.
- 워크트리 핸드오프 오케스트레이션 (`orca-cli` 영역). 이 설계는 "누가 공유 스택을 변경해도 되는가"만 답한다.
- 머신 엔진을 에이전트가 내리게 하는 명령.
- 실비밀·실데이터. 로컬 자격증명은 `root/root`, `postgres/postgres`, `minio/minio123` 그대로다.
- 1차에 `/etc/hosts` 자동 기록 (`proxy hosts`) 없음. `*.localhost`를 해석하지 못하는 도구는 doctor 경고만.

---

## Proposed Design

### 운영 모델 — 네 기둥 (구현 매핑)

스킬의 네 기둥을 소프트웨어 경계에 고정한다.

```mermaid
flowchart TB
  subgraph machine["한 개발자 머신"]
    subgraph engines["① 머신 엔진 — 이미 있음"]
      MYSQL[dev-mysql8 :3306]
      PG[dev-pg16 :5432]
      REDIS[dev-redis7 :6379]
      MORE[kafka mongo mail minio]
    end

    PROXY["③ 머신 프록시 — 옵트인\nCaddy 호스트 127.0.0.1:http_port"]

    subgraph projA["프로젝트 acme  proxy: machine"]
      BASEA["① 앱 baseline 하나"]
      OVL1["② overlay env=w1"]
      OVL2["② overlay env=w2"]
      LOCKA["④ writer lock advisory"]
    end

    subgraph projB["프로젝트 sideapp  proxy: none"]
      BASEB["앱 baseline 하나\noverlay: none 가능"]
    end

    subgraph projC["프로젝트 fulgo  proxy: project"]
      K3D["k3d 가 :80 소유 가능"]
    end
  end

  DEV[개발자 / 에이전트] -->|이름으로 가리킨다| URLS[de-novo-skills urls]
  URLS --> PROXY
  URLS --> K3D
  PROXY -->|api.acme.localhost| BASEA
  PROXY -->|api--w1.acme.localhost 붙음| OVL1
  PROXY -->|web--w1.acme.localhost 안 붙음 = 폴스루| BASEA
  BASEA --> engines
  OVL1 --> engines
  BASEB --> engines
  K3D --> engines
```

기둥 2는 **능력 사다리**다. `overlay` 생략이거나 `overlay: none` 이거나 `runtime.commands.overlay`가 없으면 이 레포는 오버레이가 된다고 말하지 않는다. 그때도 기둥 1·3(이름)·4는 동작한다.

| 사다리 | 켜지는 조건 | 이 레포가 주는 것 |
| --- | --- | --- |
| L0 엔진 | `data.infra: machine` + `data.engines` | 오늘 `setup/up/status/provision` |
| L1 주소 | `addressing` + `services` | 이름 난 URL (`de-novo-skills urls`). 리스너 없음 |
| L1 리스너 | `addressing.proxy: machine` **명시** + `de-novo-skills proxy up` | Caddy 라우트. 생략/`none`은 리스너를 안 띄움 |
| L2 오버레이 | `overlay.attachable` **그리고** `runtime.commands.overlay` | env 레지스트리, 폴스루 표, 프로젝트 명령 dispatch. Caddy 갱신은 `proxy: machine`일 때만 |
| L3 k3d | 프로젝트 `backend: k3d` (선택) | 이 레포는 위임. `addressing.proxy: project`. 클러스터·매니페스트는 프로젝트 |

티어를 과하게 잡지 않는다. 서비스 1~2개·병렬 에이전트 없음 → L1 + 기둥 4, `overlay: none`. k3d는 멀티서비스 + 병렬 에이전트 + k8s 배포 대상일 때만 값이 있다. 그 판단은 스킬이 이미 말하고, 스키마 문서가 기준을 소유한다.

### 소유 경계 — 이 레포 vs 소비 프로젝트

원칙: **프로젝트 무관한 것은 여기로 모은다. 앱 고유 매니페스트는 가져오지 않는다.**

```mermaid
flowchart LR
  subgraph here["dev-infra 소유"]
    E[엔진 compose + ENGINES 표]
    P[프로파일 스키마·불변식 검증]
    A[머신 TLD + Caddy 프록시]
    R[오버레이 라우팅 레지스트리]
    W[writer 락 파일]
    S[스킬 정본 + symlink 설치]
    C["de-novo-skills CLI"]
  end

  subgraph proj["소비 프로젝트 소유"]
    Y[".agents/runtime-profile.yml 값"]
    M[앱 compose / k8s 매니페스트]
    B[이미지 빌드, full git SHA 태그]
    O["runtime.commands.overlay 구현"]
    U["runtime.commands.up/status"]
    V[확인 도구]
  end

  Y --> C
  O -->|stdout JSON 계약| R
  R --> A
  B --> O
```

| 관심사 | 소유 | 이유 |
| --- | --- | --- |
| MySQL/PG/Redis/… 한 벌 | 이 레포 `infra/` | 이미 있고, 프로젝트마다 복제하면 포트·정본이 붕괴 |
| 머신 와일드카드 TLD | 이 레포 (머신 설정) | 프로젝트마다 TLD를 만들면 인증서·신뢰가 N배 |
| 호스트네임 폴스루 프록시 | 이 레포 (Caddy compose 프로필, 옵트인) | 라우팅 표는 프로젝트 무관. 업스트림만 프로젝트 값 |
| 오버레이 **워크로드 배치** | 프로젝트 `runtime.commands.overlay` | compose vs k3d vs 호스트 프로세스는 앱 고유 |
| 오버레이 **라우팅 표** | 이 레포 | 폴스루 이름을 한곳에서 그린다. 실제 패킷 경로는 `proxy` 값에 따라 Caddy 또는 프로젝트 |
| 앱 이미지 빌드 | 프로젝트 | SHA 태그는 앱 빌드 파이프라인 |
| 스킬 본문 | 이 레포 `skills/grove/` | 패턴의 정본. 어댑터에 복사하지 않음 |
| 스킬 로드 경로 | 이 레포가 symlink를 심음 | README가 약속하고 코드가 없던 부분 |
| 확인 방법 | 프로젝트 | Non-Goal |
| writer 락 | 이 레포 (`~/.dev-infra/locks/`) | 발견 절차. 1차는 advisory |

제네릭 compose 오버레이 헬퍼(프로젝트 compose에서 서비스 하나만 `--no-deps`로 띄우기)는 **1차 범위가 아니다.** compose `depends_on`·env·네트워크는 프로젝트마다 달라 잘못된 기본 구현이 된다. 계약이 한 프로젝트에서 검증된 뒤 별도 PR로 참고 구현을 추가한다.

### 사실의 집 — 한 사실 한 파일

구현 시 같은 불변식을 네 곳에 적지 않는다.

| 사실 | 정본 | 다른 문서는 |
| --- | --- | --- |
| 프로파일 스키마·키 의미 | `skills/grove/references/runtime-profile.md` | 스킬은 "읽어라", CLI help는 명령을 가리킨다 |
| 네 기둥·에이전트 절차 | `skills/grove/SKILL.md` | 사람용 README는 한 줄로 스킬을 가리킨다 |
| 오버레이 명령 I/O 계약 | `skills/grove/references/overlay-contract.md` (신규) | 스킬은 동사만, 스키마 문서는 키만 |
| 엔진 목록·표준 포트·분리 단위 | `infra/README.md` + `ENGINES` + `docker-compose.yml` | 스킬/스키마는 "머신 인프라"라고만 |
| CLI 명령 목록 | `infra/bin/cli.mjs` `printHelp` | README는 설치와 `setup`만 |
| 사람 온보딩 | 루트 `README.md` | 엔진 표를 복제하지 않음 |
| 이 머신의 프로젝트 인덱스 | `~/.dev-infra/projects/{slug}.yml` (도구) | `infra/registry.local.md`는 사람 메모(이관 기록)만. 라우팅이 파싱하지 않음 |
| 머신 TLD·프록시 호스트 포트 | `~/.dev-infra/config.yml` | 프로파일 `addressing.tld`는 프로젝트 스킴에 쓰는 값. 기본은 머신 설정을 따른다 |

오늘 `infra/README.md`는 `registry.local.md`를 분할 등록부 정본이라고 한다. 구현 후 도구가 읽는 정본은 `~/.dev-infra/projects/`로 옮긴다. `registry.local.md`의 이관 메모는 남긴다 — 파싱 대상이 아니다.

### 디렉터리 배치 (목표)

```
dev-infra/
  README.md                          # 사람 온보딩
  package.json                       # bin: de-novo-skills
  infra/
    docker-compose.yml               # 엔진 + proxy 프로필 (호스트 포트는 env)
    README.md                        # 엔진 + 프록시(머신 공유 프로세스)
    bin/cli.mjs                      # 디스패처
    bin/setup.mjs                    # 엔진 setup + register 호출
    bin/provision                    # 기존
    bin/overlay-stub.mjs             # PR 5 픽스처: 계약만 구현, 워크로드 없음
    lib/profile.mjs                  # 신규: 전체 프로파일 parse/validate
    lib/addressing.mjs               # 신규: URL 렌더, 스킴
    lib/proxy.mjs                    # 신규: writeCaddyfile · reload
    lib/projects.mjs                 # 신규: ~/.dev-infra/projects
    lib/overlay.mjs                  # 신규: 레지스트리 + 폴스루 표 + dispatch
    lib/writer.mjs                   # 신규: 락
    lib/skill-install.mjs            # 신규: symlink
    lib/state.mjs                    # 신규: ~/.dev-infra 경로
    lib/lockfile.mjs                 # 신규: 원자 rename + pid 검사
  skills/grove/
    SKILL.md
    references/runtime-profile.md
    references/overlay-contract.md   # 신규
    examples/*.yml                   # 기계 검증 픽스처
```

기존 주석 규약을 유지한다: 짧은 한국어, 비명백한 제약만, 구현 서사 없음.

머신 로컬 상태 (`*.local.md` / `*.local.yml`은 이미 gitignore):

```
~/.dev-infra/
  config.yml                 # tld, proxy, http_port, https
  projects/{slug}.yml        # register/setup이 쓰는 인덱스 (root 경로)
  overlays/{slug}.yml        # env → 붙인 서비스 → upstream?
  locks/{slug}.lock          # baseline writer
  caddy/Caddyfile            # writeCaddyfile만 쓰는 파일 (디렉터리면 실패)
  caddy/compose.override.yml # proxy up이 쓰는 호스트 포트 매핑
```

체크아웃에 두지 않는 이유: 이 레포의 클론이 여러 개일 수 있고, 엔진 compose 경로(`npm link`)와 무관하게 머신당 라우팅 표는 하나여야 한다.

### 머신 설정

`~/.dev-infra/config.yml` (없으면 아래 기본값으로 동작):

```yaml
addressing:
  tld: localhost          # 권장 기본. Open Questions Q1
  proxy: caddy            # 머신 프록시 구현: caddy | none  (프로파일 addressing.proxy 와 다름)
  http_port: 80           # 호스트 publish. 하나뿐인 :80 소유자
  https_port: 443
  https: off              # off | internal
```

`config.yml`의 `addressing.proxy`는 **이 머신이 Caddy를 띄울 수 있는가**다. 프로파일 `addressing.proxy`는 **이 프로젝트의 호스트네임을 누가 듣는가**다. 둘 다 `none`이면 URL만 있다.

프로파일 `addressing.tld`가 있으면 그 프로젝트 URL은 그 TLD를 쓴다. 머신 기본 TLD는 프로파일이 생략했을 때와 프록시 리스너에 쓰인다. **프로젝트마다 새 TLD를 만들지 않는 것이 기본**이다. 소유한 실도메인 하나(`local.example.co.kr`)를 머신 TLD로 쓰는 것은 허용 — 그 경우에도 스킴에 `{project}`를 넣어 충돌을 막거나, 그 도메인을 한 프로젝트가 독점한다고 프로파일에 명시한다.

---

### Addressing 층 — 포트를 고르지 않게

#### 이름 규칙

머신에 와일드카드 네임스페이스 **하나**. 기본 스킴은 멀티 프로젝트를 전제로 `{project}`를 포함한다. 여기서 `{project}`는 `project.host`(아래)다.

```
shared  : {service}.{project}.{tld}           # baseline
overlay : {service}--{env}.{project}.{tld}    # env가 살아 있고 붙었으면 overlay,
                                              # env가 살아 있고 안 붙었으면 baseline 폴스루
                                              # env가 없으면 라우트 없음 (404)
```

`--` 구분자(하이픈 둘)는 서비스 이름에 `-`가 들어가도 토큰이 갈라지게 스킬이 이미 고른 것이다. 유지한다.

한 프로젝트가 소유 도메인을 독점하면 오늘 멀티서비스 예시처럼 `{service}.{tld}` 도 허용한다. 렌더러는 프로파일 `addressing.scheme` 문자열의 `{service}` `{env}` `{project}` `{tld}` `{namespace}` 만 치환한다. 모르는 `{token}`은 validate가 거절한다.

`infra/lib/addressing.mjs`가 순수 함수로 URL을 만든다.

```js
// projectHost(profile) → profile.project.host
//   ?? slug.replaceAll('_', '-')
//   DNS 라벨 [a-z0-9]([a-z0-9-]{0,61}[a-z0-9])? 가 아니면 거절
// renderHost(scheme, { service, env, project, tld, namespace })
// renderUrl(profile, config, { service, env, protocol })
//   protocol 기본 http.
//   addressing.proxy === "machine" 이고 해당 프로토콜의 호스트 포트가
//   표준(80/443)이 아니면 :port 를 붙인다. config.http_port 는 Caddy의
//   호스트 publish이지 k3d/portless의 포트가 아니다.
//   proxy 가 project | none | portless 이면 스킴 호스트만 — Caddy 포트를
//   붙이지 않는다.
// 예: proxy machine + http_port 80   → http://api.acme.localhost
//     proxy machine + http_port 8080 → http://api.acme.localhost:8080
//     proxy project + http_port 8080 → http://seller.local.fulgo.co.kr
```

엔진용 `project.slug` / `namespace`는 오늘처럼 밑줄을 허용한다 (database 이름). 호스트네임은 `project.host`가 담당한다. `register`가 두 프로젝트의 `host`가 같으면 거절한다 (`my_app`과 `my-app`이 둘 다 `my-app`으로 접히지 않게).

최소 예시(`examples/minimal.runtime-profile.yml`)는 `{service}.{project}.{tld}`, `tld: localhost`. 멀티서비스 예시는 독점 TLD + k3d. 둘 다 유효하다. `addressing.proxy` 생략 = `none`. 멀티서비스 예시에는 `proxy: project`를 **명시**해 k3d가 라우팅을 소유함을 가르친다.

#### DNS

| TLD | 해석 | 언제 |
| --- | --- | --- |
| `localhost` (권장 기본) | OS가 `*.localhost` → 루프백 (RFC 6761). 추가 DNS 없음 | 개인 Mac, 외부 OAuth 콜백 없음 |
| 소유 실도메인 `*.local.example.co.kr` → 127.0.0.1 | DNS A 레코드 1개 | OAuth 리다이렉트·팀 공유 URL |
| dnsmasq 커스텀 TLD | `/etc/resolver/<tld>` + dnsmasq | 실도메인 없고 `localhost`가 도구에서 실패할 때 |

1차 구현은 `localhost`만 자동 셋업한다. 다른 TLD는 사용자가 DNS를 맞춘 뒤 `config.yml`/`addressing.tld`에 적는다.

`de-novo-skills doctor`의 DNS 검사: `dns.lookup(host, { family: 4 })`가 `127.0.0.1`인지 센다 (`주소 DNS 1/1`). AAAA를 쓰지 않는다.

**IPv6와 프로브 (v1에서 닫음).** macOS stub resolver는 `*.localhost`에 AAAA(`::1`)를 준다. 프록시는 호스트 `127.0.0.1:{http_port}`만 publish한다. **CLI 프로브는 호스트네임으로 connect 하지 않는다.** TCP 대상은 `addressing.proxy`로 고른다: `machine`이면 `127.0.0.1:{config.http_port}`, `project`이면 `127.0.0.1:80`(리스너가 있을 때만), `none`/`portless`는 프로브 없음. 헤더는 항상 `Host: {hostname}`. 브라우저 Happy Eyeballs가 `::1`로 실패할 수 있음은 doctor가 경고만 한다. 듀얼 스택 publish는 후속 측정이지 v1 성공 판정을 막지 않는다.

#### 머신 불변식 — `:80` 소유자는 하나

호스트 `:80`과 `:443`은 **머신 전역**이다. 프로파일 `addressing.proxy: project`는 그 프로젝트의 라우트를 Caddyfile에서 빼는 것이지, Caddy의 호스트 bind를 풀어 주지 않는다. k3d(`onedns` `k3d.yaml` `80:80`/`443:443`)와 Caddy는 **공존할 수 없다**. 퍼-프로젝트 skip은 공존 모드가 아니다.

점유 판정 `whoOwns(127.0.0.1, port)` — `de-novo-skills up`과 같이 **멱등**이다:

| 결과 | 조건 | `proxy up` |
| --- | --- | --- |
| `self` | 컨테이너 `dev-proxy`가 떠 있고 `docker port dev-proxy`가 `127.0.0.1:{port}->80`(또는 443)을 포함한다 | 계속. 두 번째 호출은 compose `up -d --wait` no-op, `프록시 1/1` |
| `free` | connect 실패 (아무도 안 듣는다) | 계속 |
| `other` | 포트는 열려 있으나 매핑이 `dev-proxy`가 아니다 | **비0**. `lsof`/`docker ps`와 처방: k3d면 로드밸런서를 `127.0.0.1:9080:80`으로 옮기거나 Caddy가 `http_port: 8080`로 양보 |

이 머신의 onedns는 **명시적 소비 프로젝트 이관 단계**다. `proxy: machine` 프로젝트를 이 Mac에서 쓰려면 그 전에 k3d가 80/443을 내놓거나 Caddy가 8080을 쓴다. `other`일 때만 실패한다 — 이미 Caddy가 잡고 있는 포트에 에이전트가 `proxy up`을 다시 치는 것은 `de-novo-skills up`과 같은 성공이다.

`de-novo-skills proxy up` 절차 (`de-novo-skills up`과 같은 멱등 `compose up -d --wait`):

1. `whoOwns`가 `other`이면 즉시 실패 (위 표). `self`/`free`는 계속.
2. `writeCaddyfile(config, projects[], overlays[])` — **유일한 Caddyfile writer**. 경로가 디렉터리면 거절 (Docker가 디렉터리를 `/etc/caddy/Caddyfile`에 마운트하는 고전적 실패). `proxy: machine` 라우트가 0개면 이 함수가 스텁 내용을 쓴다. `proxy up`은 스텁을 따로 쓰지 않는다.
3. `compose.override.yml`을 `config.yml`에서 생성한다. 호스트 포트는 `127.0.0.1:{http_port}:80`. 컨테이너 쪽은 항상 `80`. `https: off`이면 **443 매핑을 넣지 않는다**.
4. `docker compose -f infra/docker-compose.yml -f ~/.dev-infra/caddy/compose.override.yml --profile proxy up -d --wait proxy`.
5. 컨테이너 health(아래)를 센다 `프록시 1/1`.

`renderUrl`은 Caddy 호스트 포트를 **`addressing.proxy === "machine"`일 때만** 붙인다. `project`/`none`/`portless` URL은 스킴 호스트만 — 에이전트가 k3d 공존 레시피에서 `:8080`으로 Caddy 스텁을 치지 않게.

#### 프록시 — 이 레포가 제공한다 (옵트인)

선택지와 결정(대안은 Alternatives): **Caddy 2.8.x를 `infra/docker-compose.yml`의 compose profile `proxy`로 기동**한다. 이유:

- 라우팅 표가 YAML(프로파일 + 오버레이 레지스트리)에서 생성되어야 한다. "yml이 정본, CLI가 그린다"와 맞다. Traefik 도커 라벨은 정본이 라벨로 흩어진다.
- portless(vercel-labs)는 **프로세스 래퍼**다. 이미 떠 있는 baseline/overlay 컨테이너의 폴스루를 구현하지 않는다. 호스트 `next dev`용으로 프로젝트가 쓰는 것은 허용하되 (`addressing.proxy: portless`), 머신 폴스루의 정본이 아니다.
- Caddyfile은 테스트하기 쉬운 텍스트다.
- 호스트 brew Caddy는 컨테이너 내부 bind 버그를 피하지만, 바이너리·CA·업데이트가 이 레포 밖으로 샌다. 엔진과 같은 compose 패턴을 유지한다.

```yaml
# infra/docker-compose.yml — 호스트 포트는 여기에 하드코딩하지 않는다
  proxy:
    image: caddy:2.8.4
    container_name: dev-proxy
    profiles: [proxy]
    volumes:
      - ${HOME}/.dev-infra/caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
    extra_hosts:
      - "host.docker.internal:host-gateway"
    restart: unless-stopped
    healthcheck:
      # 컨테이너 내부 admin. caddy version 이 아님 — 바이너리 존재 ≠ 리스너
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:2019/config/"]
      interval: 5s
      timeout: 3s
      retries: 12
```

`~/.dev-infra/caddy/compose.override.yml` (생성물, `proxy up`만 씀). **컨테이너 listen은 항상 80**(및 https면 443). `config.http_port`는 호스트 쪽만 바꾼다. Caddyfile 글로벌 `http_port`를 `config.http_port`로 치환하지 않는다.

```yaml
# https: off, http_port: 8080  일 때
services:
  proxy:
    ports:
      - "127.0.0.1:8080:80"
# https: internal 일 때 443 줄이 추가된다. 컨테이너 443, 호스트 https_port.
#     - "127.0.0.1:443:443"
```

**LAN 위협은 호스트 publish로 막는다.** 엔진(`127.0.0.1:3306:3306` 등)과 같다. 테스트는 compose override의 `ports:`와 `docker port dev-proxy`가 `0.0.0.0`을 포함하지 않음을 고정한다.

**Caddyfile 사이트 블록에 `bind 127.0.0.1`을 넣지 않는다.** Docker는 컨테이너 eth0로 publish한다. 컨테이너 루프백만 들으면 호스트 `127.0.0.1:80`으로 들어온 패킷이 닿지 않는다. 컨테이너 안에서 Caddy는 기본(`0.0.0.0:80`)으로 듣는다. `admin localhost:2019`는 컨테이너 내부 전용이며 호스트 publish 하지 않는다.

reload: `docker exec dev-proxy caddy reload --config /etc/caddy/Caddyfile`.

#### Caddyfile 생성 — 유일한 writer

`infra/lib/proxy.mjs` `writeCaddyfile(config, projects, overlays) → string`.

**이 함수만** `~/.dev-infra/caddy/Caddyfile`을 쓴다. `setup`, `register`, `overlay --apply`, `proxy reload`, `proxy up`은 모두 여기를 통과한다. 프로젝트 A의 setup이 A만 렌더해 B를 지우는 일을 금지한다.

알고리즘:

1. `projects[]`는 `~/.dev-infra/projects/*.yml` 전부.
2. 각 항목의 `root` + 프로파일 경로에서 **라이브** yml을 읽는다. 파일이 없으면 인덱스의 스냅샷을 쓰고 doctor가 `인덱스 stale 1`을 센다.
3. `addressing.proxy !== "machine"` 인 프로젝트는 건너뛴다 (`none`/`project`/`portless`).
4. 프로젝트마다 `buildRoutes(liveProfile, overlayState)`를 호출해 합친다.
5. 호스트 문자열이 프로젝트 간에 겹치면 실패 (어느 slug 쌍인지 인쇄).
6. 부모 디렉터리 `mkdir`, 임시 파일에 쓴 뒤 `rename`으로 `Caddyfile` **파일**을 교체. 기존 경로가 디렉터리면 거절.
7. 사이트 블록이 0개이면 아래 스텁 내용을 **이 함수가** 쓴다. `proxy up` 절차에 두 번째 스텁 writer를 두지 않는다.
8. `dev-proxy`가 떠 있으면 `caddy reload --config /etc/caddy/Caddyfile`.

스텁 (machine 라우트 0개 — `writeCaddyfile` 출력). 글로벌 `http_port`는 **컨테이너 내부 80 고정**. 호스트 8080 양보는 compose override의 `127.0.0.1:8080:80`만으로 한다.

```
{
  auto_https off
  http_port 80
  admin localhost:2019
}
```

Caddy 2는 사이트 블록 없이 글로벌 옵션만으로 기동한다.

#### 업스트림 해석

Caddy는 컨테이너 안에 있으므로 `reverse_proxy 127.0.0.1:5001`은 프록시 자신이다.

| 레지스트리/프로파일이 주는 upstream | Caddyfile에 쓰는 값 | 전제 |
| --- | --- | --- |
| `127.0.0.1:5001` 또는 `localhost:5001` (호스트 관점) | `host.docker.internal:5001` | 그 포트가 호스트에 listen |
| `docker:acme-w1-api:5001` | `acme-w1-api:5001` | 워크로드가 **external 네트워크 `dev-infra`에 조인**. compose 기본 프로젝트 네트워크는 `dev-proxy`에서 resolve되지 않는다. 호스트 publish 불필요 |
| 없음 (`proxy: project` 등) | Caddy 블록 없음 | |

baseline 업스트림 기본값 (`proxy: machine`): `127.0.0.1:{services.*.port}` — 오늘 포트 등록부가 가리키는 호스트 포트. 사용자·에이전트에게 말하는 주소는 호스트네임이다. Caddy 호스트 포트(`config.http_port`)는 `proxy: machine` URL에만, 그리고 80/443이 아닐 때만 붙는다.

`docker:` 업스트림 계약 (overlay-contract.md): 프로젝트 overlay 명령이 이 형태를 보고하면, 그 컨테이너/서비스는

```yaml
networks:
  dev-infra:
    external: true
```

로 `dev-infra`에 붙어 있어야 하고, 호스트 `ports:`를 열 필요가 없다. 이것이 "포트는 늘리지 않는다"가 **실제로** 성립하는 경로다.

#### 폴스루 표

`lib/overlay.mjs` `buildRoutes(project, overlayState)` — 순수 함수, docker 없이 테스트.

입력: 프로파일 서비스 목록 + 살아 있는 env 집합 + env별 attach 맵.
출력: `{ host, upstream | null, kind: "baseline"|"overlay"|"fallthrough" }[]`.

규칙:

1. 각 서비스에 shared 호스트 하나 → baseline upstream.
2. 살아 있는 각 env × 각 서비스에 overlay 호스트 하나.
   - 그 env에 그 서비스가 attach되어 있으면 overlay upstream, `kind: overlay`.
   - 아니면 baseline upstream, `kind: fallthrough`.
3. destroy된 env의 호스트는 **표에 없다** (폴스루가 아니라 404). 폴스루는 "env는 살아 있고 이 서비스는 안 붙음"일 때만 의미가 있다.
4. `overlay.shared_only` 서비스는 attach를 거절한다. overlay 호스트는 만들어지되 항상 fallthrough.
5. 다른 프로젝트 호스트는 이 표에 없다. Caddy는 선언된 호스트만 듣는다 — 잡 올 프록시 없음.
6. `upstream === null` (`proxy: project`가 클러스터 내부를 쓸 때)인 행은 Caddyfile에 넣지 않는다.

```mermaid
sequenceDiagram
  participant A as 에이전트
  participant C as Caddy 컨테이너 :80
  participant B as baseline catalog-api
  participant O as overlay w1 catalog-api

  A->>C: GET http://127.0.0.1/health  Host catalog-api.acme.localhost
  C->>B: reverse_proxy host.docker.internal:5002
  B-->>A: 200

  A->>C: GET http://127.0.0.1/health  Host catalog-api--w1.acme.localhost
  Note over C: w1에 catalog-api attach됨
  C->>O: reverse_proxy host.docker.internal:18002
  O-->>A: 200

  A->>C: GET http://127.0.0.1/health  Host auth-api--w1.acme.localhost
  Note over C: shared_only — 항상 폴스루
  C->>B: auth-api baseline
```

#### 포트가 여전히 사용자에게 보이는 때

프록시가 켜진 뒤에도 아래는 호스트 포트로 남는다. 앱 5000/5100 블록은 `proxy: machine`일 때 업스트림이다.

| 대상 | 포트 | 이유 |
| --- | --- | --- |
| MySQL | 127.0.0.1:3306 | 표준 포트, GUI·클라이언트 기본값 |
| Postgres | 127.0.0.1:5432 | 동일 |
| Redis | 127.0.0.1:6379 | 동일 |
| Kafka | 127.0.0.1:9092 | 동일 |
| Mongo | 127.0.0.1:27017 | 동일 |
| Mailpit SMTP | 127.0.0.1:1025 | 앱 SMTP |
| Mailpit UI | 127.0.0.1:8025 | HTTP UI. 선택 후속: `mail.{tld}` |
| MinIO | 127.0.0.1:9000 / 9001 | S3 API + 콘솔 |
| 프록시 (옵트인) | 127.0.0.1:{http_port} / 선택 {https_port} | 호스트네임의 입구. 머신에 하나 |
| 앱 서비스 | 프로파일 `services.*.port` | 호스트 publish를 유지하는 한 보임. `docker:` 업스트림이면 숨김 |

`addressing.ports.blocks`와 `ports.registry`는 앱 포트 할당의 프로젝트 정본으로 남는다. doctor가 등록된 프로젝트의 포트 집합 교집합을 경고한다. 장기 진화(비범위): 프로젝트 compose가 호스트 포트를 빼고 `dev-infra` 네트워크에 조인하면 앱 포트는 호스트에서 사라진다.

#### `addressing.proxy` 값

```yaml
addressing:
  proxy: none       # 생략 시 기본. URL만. Caddyfile에 안 넣음. :80 안 건드림
  # proxy: machine  # 이 레포 Caddy가 이 프로젝트 호스트네임을 소유. 명시 옵트인
  # proxy: project  # 프로젝트가 이미 라우팅 (onedns k3d Gateway)
  # proxy: portless # 프로젝트 프로세스를 portless가 래핑. 폴스루 없음
```

**생략 = `none`.** 스키마에 `addressing`+`services`가 이미 있어도 리스너를 켜지 않는다. 이 머신의 k3d 예시가 setup만으로 `:80`을 빼앗지 않게 하기 위함이다.

`de-novo-skills urls`는 `proxy` 값과 무관하게 스킴대로 이름을 인쇄한다.

---

### Overlay 층 — 병렬 확인

#### 수명주기

```mermaid
stateDiagram-v2
  [*] --> Absent
  Absent --> Live: create env
  Live --> Live: attach / detach 서비스
  Live --> Absent: destroy env
```

| 동사 | 이 레포 | 프로젝트 명령 | 라우팅 결과물 |
| --- | --- | --- | --- |
| `create <env>` | env 이름 검증·예약, 레지스트리 추가 | 빈 환경 생성 | 그 env의 overlay 호스트 = 폴스루 (`proxy: machine`이면 Caddy에 반영) |
| `attach <env> <service> --image <ref>` | 게이트, SHA, JSON, 레지스트리, (machine이면) writeCaddyfile | 워크로드 기동 | 그 호스트 → overlay |
| `detach <env> <service>` | 레지스트리에서 제거, (machine이면) reload | 워크로드 제거 | 그 호스트 → baseline |
| `destroy <env>` | 레지스트리에서 env 삭제 | 환경 전부 제거 | overlay 호스트 사라짐 |
| `status [env]` | 라우팅 표를 센다 | 선택적으로 워크로드 상태 | `overlay 환경 n, attach n/n` |

능력 게이트 — `infra/lib/overlay.mjs` `assertOverlayActive(profile)`:

1. `overlay` 생략 또는 `overlay: none` → 거절. 메시지: `overlay 비활성 (선언 없음)` / `overlay 비활성 (overlay: none)`. 동사를 발명하지 않음.
2. `runtime.commands.overlay` 없음 → 거절. 메시지: 명령이 없다, 발명하지 않는다.
3. `overlay`가 객체인데 `attachable`이 없거나 빈 리스트 → 거절.
4. `runtime.commands.overlay`가 있는데 `overlay` 생략 또는 `overlay: none` → **validate부터 거절** (명령만 있고 기둥이 꺼진 상태).
5. 그 외만 create/attach/… 수행.

#### env 이름

- 필수 인자. 자동 난수는 만들지 않는다.
- 패턴: `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$` — DNS 라벨 상한(63)에 맞춘다. onedns `{0,61}`과 같다. 이 CLI가 더 짧게 자를 이유는 없다.
- 유일 범위: **프로젝트 slug 안**. `acme/w1`과 `sideapp/w1`은 공존.
- 충돌: 거절. 접미사 자동 부여 없음.
- 예약 접두사 없음. `wt-` / `integration-`은 인자에 넣으면 그대로.

#### 이미지 태그

`overlay.image_tag: full-git-sha` (스키마 기본): `--image`는 다음 중 하나.

- 태그 끝이 `:[0-9a-f]{40}`
- 또는 `@sha256:[0-9a-f]{64}`

`latest`, `dev`, 짧은 SHA는 거절. **빌드는 프로젝트가 한다.**

#### 프로젝트 명령 계약

정본: `references/overlay-contract.md`. 스킬은 동사 목록만 남기고, 에이전트는 **`de-novo-skills overlay`만** 호출한다 (프로젝트 명령을 직접 치지 않음 — PR 5에서 스킬 세 줄을 같이 고친다).

호출:

```text
cwd     = 프로파일이 있는 프로젝트 루트 (realpath)
timeout = 120s  (ENV DEVINFRA_OVERLAY_TIMEOUT_MS 로 덮어씀)
argv    = [...runtime.commands.overlay.split, verb, ...cliArgs]
```

`runtime.commands.overlay`가 `node tools/dev-overlay.mjs`이면 그 앞에 `node` 경로를 프로젝트 루트 기준으로 실행한다. **동사 뒤의 모르는 플래그는 그대로 통과**한다 (`--revision`, `--from-namespace`, `hosts`, `baseline` 등). 이 CLI가 해석하는 것은 `--apply`, `--image`, `<env>`, `<service>`뿐.

**plan-first. stderr를 파싱해 재시도하지 않는다.**

| `overlay.plan_first` | `de-novo-skills overlay …` (플래그 없음) | `… --apply` |
| --- | --- | --- |
| 생략 또는 `true` (기본) | 프로젝트 명령을 `--apply` 없이 호출. 레지스트리·Caddy **불변**. 명령은 계획만 인쇄해야 한다 (onedns `printPlan`과 같음) | `--apply`를 붙여 호출. `ok:true` 뒤에만 레지스트리·Caddy 갱신 |
| `false` | 프로젝트 명령을 **호출하지 않는다**. 메시지: `이 overlay 명령은 plan-first가 아니다. --apply가 필요하다.` | `--apply` 없이 프로젝트 명령을 한 번 호출 (명령이 `--apply`를 모를 수 있음). 성공 JSON 뒤에 레지스트리 갱신 |

알 수 없는 플래그 재시도·stderr 휴리스틱은 없다. 계획 경로에서 always-execute 명령을 돌리면 레지스트리와 워크로드가 어긋난다.

**stdout 계약.** 마지막 비어 있지 않은 줄이 JSON 한 객체. `ok`가 없거나 `ok: false`면 **exit 0이어도 실패**. 줄 단위 `upstream: host:port` 호환은 두지 않는다 — 구현체가 둘이면 파서가 갈라진다.

```json
{
  "ok": true,
  "verb": "attach",
  "env": "w1",
  "service": "catalog-api",
  "image": "acme/catalog-api:0123456789abcdef0123456789abcdef01234567",
  "upstream": "127.0.0.1:18002"
}
```

| 동사 | 필수 필드 | `upstream` |
| --- | --- | --- |
| create | `ok`, `verb`, `env` | 없음 |
| attach | `ok`, `verb`, `env`, `service`, `image` | `proxy: machine`이면 **필수**. `project`/`none`/`portless`면 생략 가능 (Gateway ClusterIP는 호스트 포트가 없음) |
| detach | `ok`, `verb`, `env`, `service` | 없음 |
| destroy | `ok`, `verb`, `env` | 없음 |
| status | `ok`, `verb` | 없음. 추가 필드는 자유 (onedns `environment`/`namespace`/`revision`/`overrides`를 허용) |

onedns `dev-overlay.mjs`는 오늘 이 JSON을 내지 않는다. "한 줄만 추가하면 된다"고 말하지 않는다. `proxy: project` 경로에서 `upstream`이 선택이고 `{ok:true, verb, env, service, image}`만 맞으면 attach가 레지스트리를 갱신할 수 있다. 그 이관은 소비 프로젝트 작업이며 1차 픽스처가 아니다.

**레포 픽스처** `infra/bin/overlay-stub.mjs`: plan-first, `--apply`, 위 JSON, 워크로드 없음. `proxy: machine`이면 `upstream: 127.0.0.1:9` 같은 가짜 값을 낸다. PR 5 테스트가 이 스텁만으로 L2 레지스트리·폴스루·게이트를 돌린다.

#### 성공 판정 (attach `--apply`) — `addressing.proxy`로 갈라진다

공통:

1. 프로젝트 명령이 timeout 안에 끝남.
2. 마지막 줄 JSON `ok: true`. `ok: false`는 실패.
3. 이미지 태그 규칙.
4. 레지스트리 원자 갱신.

그 다음:

| `addressing.proxy` | Caddy | 프로브 |
| --- | --- | --- |
| `machine` | `writeCaddyfile` + reload 성공. attach에 `upstream` 필수. `127.0.0.1`/`localhost` → Caddyfile에서 `host.docker.internal` | `127.0.0.1:{config.http_port}` + `Host: {overlay-host}` + health 경로(`services.*.health`, 없으면 `/`). 2xx를 `overlay attach 1/1`로 센다 |
| `project` | Caddy 건너뜀 | **Caddy `http_port`를 쓰지 않는다.** 호스트 `:80`이 listen 중이면 `127.0.0.1:80` + `Host` 프로브 (k3d가 80을 유지한 공존 레시피). 없으면 프로브를 건너뛰고 JSON을 결과물로 센다 (`overlay attach 1/1 (프로브 생략: 리스너 없음)`). Caddy가 8080으로 양보한 머신에서 k3d URL을 `:8080`으로 치면 스텁 404가 된다 — 그 포트를 붙이지 않는 것이 이 행의 전부다 |
| `portless` / `none` | Caddy 건너뜀 | 프로브 생략. JSON이 결과물. URL에 Caddy 포트 없음 |

인쇄 예: `overlay attach 1/1: catalog-api--w1 → overlay (0123456789ab…)`.

#### 누가 빌드하고 누가 붙이나

에이전트 절차 (스킬이 말하고 CLI가 강제):

1. 프로파일을 읽어 overlay가 활성인지 본다. 아니면 멈춘다.
2. 이미지를 프로젝트 방식으로 빌드해 full SHA로 태그한다. `de-novo-skills`는 빌드하지 않는다.
3. `de-novo-skills overlay create <env>` (이미 있으면 멱등 no-op).
4. `de-novo-skills overlay attach <env> <service> --image <ref> --apply`.
5. 인쇄된 overlay URL로 확인한다 (도구는 프로젝트 몫).
6. 즉시 detach, 작업 끝나면 destroy.

#### writer와의 관계

`writers: 1`은 **앱 baseline**의 쓰기다. 서로 다른 env에 attach하는 것은 병렬이 목적이다 — baseline writer를 요구하지 않는다. 같은 slug의 overlay 레지스트리 갱신은 `lib/lockfile.mjs`로 직렬화되고 마지막 apply가 이긴다. env 소유자(`agent`, `worktree`)를 레지스트리에 기록해 status에 보여 준다.

baseline `up`/마이그레이션/프로필 전환은 writer 락이 **권장**된다. CLI가 `commands.up`을 막지는 않는다 (1차).

#### 레지스트리 스키마

`~/.dev-infra/overlays/{slug}.yml`:

```yaml
project: acme
envs:
  w1:
    created_at: 2026-09-02T10:00:00+09:00
    worktree: /Users/denovo/orca/workspaces/acme/w1
    agent: grok
    services:
      catalog-api:
        image: acme/catalog-api:0123456789abcdef0123456789abcdef01234567
        upstream: 127.0.0.1:18002        # 생략 가능 (proxy: project)
        attached_at: 2026-09-02T10:05:00+09:00
```

`worktree` = `realpath(process.cwd())` at create. `agent` = `process.env.DEVINFRA_AGENT ?? process.env.USER ?? "unknown"`.

이 파일은 이 레포가 아는 라우팅 정본이다. 프로젝트 클러스터와 drift가 나면 `overlay status`가 프로젝트 명령을 호출해 비교하고, 불일치를 센다. 자동 복구 controller는 만들지 않는다.

---

### Single writer — 작은 발견 절차

오케스트레이션을 만들지 않는다. 락 파일 하나다. **1차는 advisory** — 발견과 표시. `runtime.commands.up`을 거절하지 않는다.

경로: `~/.dev-infra/locks/{slug}.lock`

```yaml
pid: 38421
host: denovo-mac
worktree: /Users/denovo/orca/denovo/acme
agent: grok
acquired_at: 2026-09-02T10:00:00+09:00
```

- `agent`: `process.env.DEVINFRA_AGENT ?? process.env.USER ?? "unknown"`
- `worktree`: `realpath(process.cwd())` at acquire
- `host`: `os.hostname()`

명령:

```
de-novo-skills writer [프로젝트루트]           # status. 기본
de-novo-skills writer acquire [프로젝트루트]
de-novo-skills writer release [프로젝트루트]
```

규칙:

- `runtime.writers`가 존재하면 **1만** 허용. 생략은 1로 간주. `2` 또는 `false`는 validate 실패 (불변식).
- `acquire`: 파일이 없고 pid가 살아 있지 않으면 기록. pid가 살아 있으면 거절하고 현재 worktree·pid를 인쇄.
- pid 생존: `process.kill(pid, 0)`. 죽은 pid는 경고 후 탈취.
- `release`: 자기 pid이거나 `--force` (사람만. 에이전트 스킬은 force를 쓰지 않음).
- 원자성: `infra/lib/lockfile.mjs`. POSIX에서 임시 파일에 쓰고 `rename(2)` (같은 파일시스템에서 원자). Node `flock`/`lockf` 바인딩과 `flock(1)`에 의존하지 않는다 — 이 레포 Node는 버전 핀이 없고 macOS에 `flock(1)`이 없다. 새 npm 의존성을 넣지 않는다. 한 사용자 Mac의 TOCTOU 창은 수락.
- overlay 레지스트리 갱신도 같은 rename 헬퍼를 쓴다.
- 보호 대상(문서·스킬): 프로젝트 baseline을 바꾸는 일. `de-novo-skills setup`(엔진)과 overlay attach는 **락 밖**.
- 1차는 `writer`를 status/doctor에 보여 주고 스킬이 절차를 말한다. **강제 `up` 차단은 2차.**

orca-cli 핸드오프는 이 파일을 읽고 `release`/`acquire`를 호출하면 된다. 그 프로토콜은 여기 범위가 아니다.

한계 (수락): pid 재사용 창, advisory, 한 사용자 Mac. TTL·원격 락은 만들지 않는다.

---

### Profile as source of truth

#### parse 분리

오늘 `readProfile`은 엔진 setup 전용이다. 둘로 나눈다.

- `infra/lib/profile.mjs` `parseProfile(yamlText, source)` → 전체 문서. `data.infra: project`도 파싱한다 (urls/validate/register용).
- `infra/bin/setup.mjs` `readProfile`는 `parseProfile` 후 `data.infra === "machine"` 을 요구하고 엔진 계획만 반환 — 기존 테스트 유지. setup 성공 후 `registerProfile(root)`를 호출해 인덱스를 갱신한다.

`parseProfile`이 항상 검사하는 것:

| 검사 | 실패 시 |
| --- | --- |
| 최상위 키 화이트리스트: `version`, `project`, `addressing`, `runtime`, `services`, `overlay`, `data` | 그 외(`qa` 포함) 거절 |
| `project.slug` 형식 `[a-z][a-z0-9_-]*` | 오늘과 동일 |
| `project.namespace` 동일, 기본 = slug | 오늘과 동일 |
| `project.host`가 있으면 DNS 라벨 `[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?` | 거절. 생략 시 slug의 `_`→`-`. 그 결과도 DNS 라벨이어야 함 |
| `runtime.single_stack`가 있으면 `true`만 | `false` 거절. 생략은 true |
| `runtime.writers`가 있으면 `1`만 | 그 외 거절. 생략은 1 |
| `data.forbid_direct_db_writes`가 있으면 `true`만 | `false` 거절. **생략은 true** (`writers`와 같은 불변식) |
| `data.engines` 키는 `ENGINES`/`ALIASES`에 있을 것 | 오늘과 동일 |
| `overlay` 생략 | L2 off. 유효 |
| `overlay: none` | L2 off. `attachable`과 공존 불가 |
| `overlay`가 객체 | `attachable` 비어 있지 않은 리스트 필수 |
| `overlay.attachable` ⊆ `services` 키 | 거절 |
| `overlay.shared_only` ∩ `attachable` = ∅ | 거절 |
| `runtime.commands.overlay` + (`overlay` 생략 또는 `none`) | 거절 |
| `services` 키는 DNS 라벨 | 거절 |
| `addressing.scheme.*` 토큰 집합 | 거절 |
| `overlay`가 객체인데 scheme.overlay 없음 | 거절 |
| `addressing.proxy` | 생략=`none`. 값 `none\|machine\|project\|portless`만 |
| `overlay.plan_first` | 생략=`true`. `true\|false`만 |

알 수 없는 최상위 키 거절은 `qa:` 재도입을 막는다. `services.*.` 임의 키는 허용하되 `kind/port/health/reflect`만 문서화한다.

생략 가능한 블록: `addressing`, `services`, `overlay`, `runtime.profiles`. 엔진만 있는 프로파일은 오늘처럼 `setup`이 통과한다. L1 명령(`urls`)은 `services`가 없으면 `서비스 0 — 주소 없음`을 센다.

#### 기계 검증 픽스처

`npm test`가 `skills/grove/examples/*.yml`을 `parseProfile`로 통과시킨다.

- `examples/minimal.runtime-profile.yml` — `overlay: none`. `addressing.proxy` 생략(= none) 유효. 원하면 명시 `none`.
- `examples/multi-service.runtime-profile.yml` — **`addressing.proxy: project`를 추가**한다. k3d + `node tools/dev-overlay.mjs`가 머신 Caddy 기본이라고 가르치지 않게.

깨진 픽스처:

- `writers: 2` → throw
- `single_stack: false` → throw
- `forbid_direct_db_writes: false` → throw
- `overlay.attachable`에 없는 서비스
- 모르는 엔진
- `qa:` 최상위 키
- `overlay: none` 인데 overlay 명령이 있음
- overlay 명령이 있는데 overlay 블록 생략
- `project.slug: my_app` 이고 `project.host` 생략 → host `my-app`으로 통과 (엔진 전용 밑줄)
- `project.host: my_app` → throw (DNS 아님)

테스트 파일: `infra/bin/profile.test.mjs` (기존 `node --test infra/bin/`에 포함).

#### `de-novo-skills validate [루트]`

docker 없이 프로파일만. 결과물:

```
■ acme — 프로파일
  불변식  5/5: single_stack writers forbid_direct_db_writes engines keys
  overlay 활성 (attachable 5, shared_only 2, command 있음)
  주소    scheme ok, tld localhost, proxy none
```

실패 항목만 비0. setup은 엔진 경로 앞에서 invariants를 같은 함수로 돌린다.

#### `de-novo-skills register [루트]`

`data.infra`와 무관하게 인덱스를 upsert한다. `infra: project` 레거시도 주소를 등록할 수 있다 — setup이 거절해도 라우팅 인덱스는 별개다.

쓰는 필드: `root`, `profile` 경로, `slug`, `host`, `addressing`, `services` 스냅샷, `registered_at`.

라이브 프로파일이 정본이고 스냅샷은 루트가 사라졌을 때의 fallback. `writeCaddyfile`은 라이브를 선호한다.

`setup`은 엔진 준비 후 `register`와 같은 함수를 호출한다.

---

### CLI 표면 — `de-novo-skills` 확장

한 바이너리. `printHelp`에 명령을 추가하고 불변식 설명은 넣지 않는다. **1차 표면은 이 목록이 닫힌다.** `proxy hosts`는 없다. `--https`는 `proxy up`에만 있다.

```
de-novo-skills setup [루트]                 # 기존 엔진 + register + (떠 있는 Caddy면) writeCaddyfile
de-novo-skills up [엔진…]                   # 기존. proxy 안 넣음
de-novo-skills status                       # 기존 엔진 + proxy 한 줄 (떠 있으면)
de-novo-skills provision …                  # 기존

de-novo-skills validate [루트]
de-novo-skills register [루트]              # 인덱스 upsert. infra: project 허용
de-novo-skills urls [루트]                  # 이름 표. --probe 는 v4+Host
de-novo-skills doctor [루트]

de-novo-skills proxy up [--https]
de-novo-skills proxy status
de-novo-skills proxy reload

de-novo-skills overlay create|attach|detach|destroy|status
de-novo-skills writer [status|acquire|release]
de-novo-skills skill install|status
```

`proxy up --https`: `config.yml` `https: internal`로 쓰고 override에 443을 넣는다. 호스트 trust store (`caddy trust`)는 컨테이너 안에서 호스트 키체인을 고치지 못한다 — 명령이 안내만 하고, 사람이 mkcert/키체인을 처리한다. 기본은 HTTP.

`status` 기본은 머신 엔진(+프록시). 프로젝트 루트를 주면 urls·writer·overlay 요약을 덧붙인다. `setup`/`up`/`overlay attach --apply`/`doctor`/`proxy up`은 센 결과물이 모자라면 비0.

출력 톤은 기존과 같다:

```
■ acme (namespace: acme) — 머신 공유 인프라 준비
  엔진  3/3: mysql8(healthy) redis7(healthy) kafka(running)
  DB    1/1:
        mysql://acme:acme@127.0.0.1:3306/acme
  프록시 0/1: 안 떠 있음 (addressing.proxy none)
  주소  7/7: catalog-api.acme.localhost → (인쇄만)
  쓰기  1/1: /Users/…/acme (pid 38421)   # advisory
  overlay 비활성 (overlay: none)
```

#### setup의 추가 책임

1. 기존 엔진 기동 + provision.
2. `parseProfile` 불변식 (엔진 키가 아니라도 writers=2면 실패).
3. `register`와 동일 함수로 인덱스 upsert. **라이브 경로를 저장**하고, Caddyfile 생성은 스냅샷이 아니라 라이브를 읽는다.
4. 인덱스를 다시 읽어 `writeCaddyfile`. `proxy: machine`인 프로젝트가 하나도 없으면 스텁만 남긴다. **proxy가 안 떠 있으면 setup이 proxy up 하지 않는다.**
5. `registry.local.md`를 파싱·갱신하지 않는다.

---

### Skill 배포

정본: `skills/grove/` (이 레포). 본문을 도구별 디렉터리에 복사하지 않는다.

```
de-novo-skills skill install                 # 전역: 존재하는 홈 로드 경로에 symlink
de-novo-skills skill install --project <루트>
de-novo-skills skill status
```

전역 타깃 — **디렉터리가 이미 있을 때만** (또는 `--force`):

- `~/.agents/skills/grove`
- `~/.claude/skills/grove`
- `~/.grok/skills/grove` — 경로가 이 대화의 전제이며 미검증. 디렉터리 없으면 건너뛰고 status에 `grok 경로 없음 (미검증)` 

전부 정본의 **절대** realpath를 가리킨다 (`npm link` + `realpath`). 홈 아래라 커밋되지 않는다.

프로젝트 타깃:

- `<root>/.agents/skills/grove` → 정본 **절대** 경로. **머신 로컬. 커밋하지 마라.** 다른 머신에서 `/Users/denovo/...`가 깨진다. 온보딩 README와 `--project` 출력이 이를 말한다. 프로젝트 `.gitignore`에 넣는 것을 권장 (`/.agents/skills/grove`).
- `<root>/.claude/skills/grove` → `../../.agents/skills/grove` **상대** (onedns와 같음). `.agents` 엔트리가 gitignore면 이 상대 링크만으로는 복제본에서 안 풀린다 — 전역 홈 설치가 본선.
- `<root>/.grok/skills/grove` → 같은 상대. `.grok`가 없으면 `--force` 없이 만들지 않음.

이미 파일이고 symlink가 아니면 거절. `skill status`는 각 경로가 정본을 realpath로 가리키는지 센다.

`setup`은 스킬을 자동 설치하지 않는다.

스킬 본문 (PR 5에서 세 줄 — doctor PR로 미루지 않음):

1. baseline을 바꾸기 전에 `de-novo-skills writer`로 소유자를 본다.
2. 주소는 `de-novo-skills urls` — 포트를 고르지 않는다.
3. overlay 동사는 `runtime.commands.overlay`가 있을 때만 **`de-novo-skills overlay …`**. 프로젝트 명령을 직접 발명·호출하지 않는다.

스키마 키를 스킬에 재진술하지 않는다.

---

## API / Interface Changes

### CLI (before → after)

Before: `setup | up | status | provision | help`.

After: 위에 닫힌 목록. 기존 네 명령의 엔진 의미는 유지. `status`에 프록시 한 줄이 붙는 것은 하위 호환(추가 출력).

`readProfile` 반환에 필드가 늘어도 `planSetup`은 `{ slug, namespace, engines }`만 쓴다. 기존 `setup.test.mjs`는 그대로 통과해야 한다.

### 프로파일 — 새 키는 최소

```yaml
project:
  host: acme              # 생략 시 slug의 _ → -
addressing:
  proxy: none | machine | project | portless   # 생략 = none
overlay:
  plan_first: true        # 생략 = true
```

`qa:`는 계속 없음. 예시에 넣지 않는다. 멀티서비스 예시는 `addressing.proxy: project`.

### 오버레이 명령 stdout

위 JSON. `ok: true` 필수. `upstream`은 `proxy: machine` attach에만 필수. onedns 강제 이관 없음.

### 생성 Caddyfile (개념)

컨테이너 내부 `bind` 없음. 호스트 LAN 차단은 compose override의 `127.0.0.1:`.

```
{
  auto_https off
  http_port 80
  admin localhost:2019
}

http://catalog-api.acme.localhost {
  reverse_proxy host.docker.internal:5002
}

http://catalog-api--w1.acme.localhost {
  reverse_proxy host.docker.internal:18002
}

http://auth-api--w1.acme.localhost {
  reverse_proxy host.docker.internal:5001
}
```

`https: internal`이면 사이트 블록을 `https://`로 바꾸고 `tls internal`.

---

## Data Model Changes

애플리케이션 DB 스키마 없음. 머신 로컬 파일만.

| 파일 | 역할 | 마이그레이션 |
| --- | --- | --- |
| `~/.dev-infra/config.yml` | 머신 TLD/http_port/https | 없으면 기본값. 생성은 `proxy up` |
| `~/.dev-infra/projects/{slug}.yml` | 프로젝트 인덱스 | `register`/`setup`. `registry.local.md` 자동 import 없음 |
| `~/.dev-infra/overlays/{slug}.yml` | overlay 라우팅 정본 | 없으면 환경 0 |
| `~/.dev-infra/locks/{slug}.lock` | writer advisory | 없으면 비어 있음 |
| `~/.dev-infra/caddy/Caddyfile` | `writeCaddyfile`만 기록 | 부트스트랩 스텁. 디렉터리면 실패 |
| `~/.dev-infra/caddy/compose.override.yml` | 호스트 포트 매핑 | `proxy up`이 생성. 443은 https on일 때만 |
| `infra/docker-compose.yml` | `proxy` 서비스 + `caddy_data`. **ports 없음** | 기존 엔진 볼륨 이름 유지 |

`docker compose down -v`는 여전히 모든 프로젝트 엔진 데이터(+ caddy_data)를 지운다. 명령은 제공하지 않는다. infra README의 경고를 프록시 볼륨까지 한 문장으로 확장한다.

엔진 문자 변환(`-`→`_`, `_`→`-`)은 오늘 `readProfile` 그대로.

---

## Alternatives Considered

### A. 주소 층: 머신 Caddy vs 프로젝트 portless vs Traefik vs 안 함

| 대안 | 이득 | 비용 | 결정 |
| --- | --- | --- | --- |
| **Caddy compose 프로필 (채택)** | YAML→Caddyfile이 정본 패턴과 맞음. 폴스루를 한곳에서 구현. 엔진과 같은 127.0.0.1 **호스트** publish | :80 충돌(k3d). 컨테이너 내부는 0.0.0.0 listen | 채택. 리스너는 `proxy: machine` 옵트인 |
| 머신 Traefik + 도커 라벨 | 컨테이너 자동 발견 | 정본이 라벨로 흩어짐. k3d/호스트 프로세스와 불일치 | 거부 |
| portless를 머신 정본 | onedns가 이미 씀. HTTPS 래핑에 강함 | 프로세스 래퍼라 컨테이너 폴스루·멀티 프로젝트 라우팅 표가 없음 | 프로젝트 탈출구로만 |
| 프록시 없이 문서만 | 구현 적음 | 이름 계약은 가능하나 리스너가 없음 | L1 URL은 이 경로 (`proxy: none`). 리스너는 옵트인 |
| 프로젝트마다 프록시 | 충돌 적음 | TLD·인증서·:80이 프로젝트 수만큼. 통합 실패 | 거부 |

### A2. k3d Gateway를 머신 프록시로 쓸 것인가

| 대안 | 이득 | 비용 | 결정 |
| --- | --- | --- | --- |
| 모든 프로젝트의 `:80`을 k3d Gateway에 맡김 | 이 머신 onedns와 :80 전쟁이 없음 | compose-only 프로젝트(minimal 예시, 엔진만 쓰는 앱)가 k3d·Istio·Gateway API를 강제받음. 이 레포 Non-Goal | **거부** |
| **Caddy(compose-only·옵트인) + k3d는 `proxy: project` (채택)** | 작은 프로젝트는 k3d 없이 이름+선택 리스너. 기존 k3d는 :80을 유지 | 한 머신의 :80은 여전히 하나 — `proxy up`은 **other**만 거절, self는 멱등. `project` URL에 Caddy `http_port`를 붙이지 않음 | 채택 |

### A3. Caddy를 호스트(brew)에 둘 것인가

| 대안 | 이득 | 비용 | 결정 |
| --- | --- | --- | --- |
| brew/caddy 호스트 프로세스 | 컨테이너 `bind 127.0.0.1` 버그가 원리적으로 없음. 호스트 키체인 trust가 쉬움 | 바이너리·버전·CA가 `infra/docker-compose.yml` 밖. 엔진 패턴과 갈라짐. CI/다른 Mac 재현이 약함 | **거부** (Q2). 컨테이너 Caddy + **호스트** `127.0.0.1:port` publish + 컨테이너 기본 listen |
| **Caddy 이미지 in compose (채택)** | 엔진과 수명·네트워크(`dev-infra`)를 공유. `host.docker.internal` 업스트림 | :80 점유 프로브 필요. IPv6는 프로브가 v4 고정 | 채택 |

### B. 오버레이: 이 레포 제네릭 컨트롤 플레인 vs 계약만 vs 아무것도

| 대안 | 이득 | 비용 | 결정 |
| --- | --- | --- | --- |
| **라우팅 제어면 + 워크로드 계약 (채택)** | 이름·레지스트리는 통일. compose/k3d는 프로젝트에 남김 | 프로젝트가 JSON을 맞춰야 함. onedns는 즉시 드라이브되지 않음 | 채택. `proxy: project`는 upstream 생략 |
| 이 레포가 compose overlay까지 기동 | 작은 프로젝트가 명령 없이 L2 | 잘못된 기본 구현. 스킬의 "명령을 발명하지 마라"와 충돌 | 2차 참고 구현으로 미룸 |
| 계약 문서만, 라우팅도 프로젝트 | 이 레포가 얇음 | 호스트네임 폴스루가 프로젝트마다 달라짐 | 거부 |
| onedns `dev-overlay.mjs`를 이 레포로 이동 | 검증된 코드 | k3d/Istio/Gateway API 의존. 프로젝트 무관이 아님 | 거부 |

### C. 멀티 프로젝트 호스트: `{service}.{project}.{tld}` vs 프로젝트별 TLD vs `{service}.{tld}`만

| 대안 | 이득 | 비용 | 결정 |
| --- | --- | --- | --- |
| **기본 스킴에 `{project}` (채택)** | 한 TLD, 충돌 없음, 인증서 1벌 | URL이 조금 김 | 채택. `{project}` = `project.host` |
| 프로젝트마다 TLD | URL이 짧음 (`api.local.acme.dev`) | 인증서·DNS·신뢰가 N배. 스킬이 이미 말림 | 소유 도메인 독점일 때만 허용 |
| `{service}.{tld}`만 | 가장 짧음 | 두 번째 프로젝트가 `api`를 쓰는 순간 붕괴 | 거부 |

### D. writer: 락 파일 vs 프로파일 필드만 vs 리스 큐

| 대안 | 이득 | 비용 | 결정 |
| --- | --- | --- | --- |
| **pid 락 파일 + rename (채택)** | 발견 가능, 구현 작음, orca-cli가 읽기 쉬움 | pid 재사용, **강제력은 advisory** | 채택 |
| `runtime.writer_worktree`를 yml에 고정 | git에 남음 | 머신 상태가 레포에 들어감 | 거부 |
| onedns `lease-queue.mjs` 일반화 | 더 풍부 | 과함. 프로덕션 큐 | 거부 |

### E. 스킬 배포: symlink vs 복사 vs 서브모듈

| 대안 | 이득 | 비용 | 결정 |
| --- | --- | --- | --- |
| **symlink 어댑터 (채택)** | 본문 한 곳. onedns가 검증 | 프로젝트 절대 symlink는 커밋하면 타 머신에서 깨짐 → gitignore | 채택 |
| 본문 복사 | 오프라인 간단 | 즉시 drift. README가 이미 금지 | 거부 |
| git submodule | 버전 핀 | 에이전트 로드 경로 문제는 안 풀림 | 거부 |

### F. 기본 TLD: `localhost` vs 소유 도메인 vs `lvh.me`

Open Questions Q1. 1차는 `localhost`. `lvh.me`/nip.io는 제3자 DNS에 루프백을 맡기는 것이라 부적합하다.

---

## Security & Privacy Considerations

위협 모델: **한 사람 개발자 머신.** 자격증명은 로컬용(root/root). 실비밀 없음. 그래도 아래는 지킨다.

| 위협 | 심각도 | 완화 |
| --- | --- | --- |
| 프록시/엔진이 LAN에 열림 | 높음 | compose **호스트** `127.0.0.1:…`만. 테스트는 override `ports:`와 `docker port`에 `0.0.0.0` 없음. Caddyfile `bind`로 막지 않음 (막으면 트래픽이 안 들어옴) |
| 프로젝트 A 호스트가 프로젝트 B 업스트림으로 감 | 높음 | `writeCaddyfile`이 선언 서비스만, 호스트 충돌 실패. 잡 올 없음. `{project}` = `project.host` |
| overlay 호스트가 다른 env 트래픽을 받음 | 중간 | 호스트네임이 env를 고른다. 이 레포 프록시는 `X-Dev-Env`를 주입하지 않음 |
| `docker compose down -v` | 높음 | `de-novo-skills down` 없음. infra README 경고 |
| 락 파일을 우회하고 baseline을 내림 | 낮음 | **advisory**. 보안 경계가 아니라 협업 신호 |
| Caddy admin API 노출 | 중간 | `admin localhost:2019` (컨테이너 내부). 호스트 publish 없음 |
| 생성된 Caddyfile에 실비밀 | 낮음 | 업스트림은 host:port뿐 |
| overlay 이미지를 레지스트리에 push | 낮음 | 이 CLI는 push하지 않음 |

인증: 없음. 루프백만 신뢰.

HTTPS 내부 CA는 호스트 trust가 필요하다. `--https`는 안내 후 사람이 확인. 기본 off.

---

## Observability

메트릭 서버·APM 없음 (한 머신). 관측은 **센 결과물 + 로그**.

**로그**

- CLI는 stdout에 요약, 실패는 stderr. 기존 패턴.
- Caddy 접근 로그는 1차 off. 디버그는 `docker logs dev-proxy`.
- overlay dispatch는 프로젝트 명령의 stdout/stderr를 inherit 하고, 마지막 JSON만 파싱.

**지표 (인쇄하는 분수)**

| 명령 | 분수 |
| --- | --- |
| `up` / `setup` | `엔진 ready/declared`, `DB provisioned/planned` (기존) |
| `proxy up/status` | `프록시 1/1` (admin health). `other` 점유만 `프록시 0/1: :80 점유 (k3d-…)` — `dev-proxy` self는 성공 |
| `urls` / `doctor` | `주소 n/n` (v4+Host 프로브 또는 인쇄만), `DNS 1/1` (`family: 4`) |
| `overlay attach` | `overlay attach 1/1` — 표는 proxy 모드를 따름 |
| `overlay status` | `환경 n, attach n, fallthrough n, drift n` |
| `writer` | `쓰기 1/1` 또는 `쓰기 0/1 (없음)` (advisory) |
| `skill status` | `로드경로 n/n` |
| `validate` | `불변식 n/n` |
| `register` | `인덱스 1/1` |
| `doctor` | 위 합. 하나라도 모자라면 비0 |

**알림:** 없음.

**프로브 예산:** 서비스당 HTTP 1회, timeout 1s, **대상 `127.0.0.1:{port}` + `Host`**. `{port}`는 `proxy: machine`이면 `config.http_port`, `proxy: project`이면 `80`(리스너 있을 때만). `dns.lookup`은 doctor DNS 줄에만, `{ family: 4 }`. 외부 네트워크 호출 없음.

---

## Rollout Plan

피처 플래그는 **프로파일 능력 사다리**다. 기존 엔진만 쓰는 프로젝트는 프로파일을 안 고쳐도 `setup`이 동작해야 한다. `addressing`+`services`만 채워도 **리스너는 안 뜬다** (`proxy` 생략 = `none`).

1. **PR 순서대로 머지.** 각 PR은 테스트 통과·독립 리뷰 가능. 아래 PR Plan.
2. **엔진 사용자 (오늘).** 동작 불변. validate가 writers·forbid 생략을 불변식 참으로 본다.
3. **L1 URL 옵트인.** `addressing`+`services` → `de-novo-skills urls`. CORS는 프로젝트 작업.
4. **L1 리스너 옵트인.** 명시 `addressing.proxy: machine` + 이 머신 `:80`이 비어 있음(또는 `http_port` 양보) + `de-novo-skills proxy up`.
5. **L2 옵트인.** `overlay.attachable` + 프로젝트 overlay 명령이 JSON 계약. 스텁으로 이 레포가 먼저 검증. onedns는 `proxy: project` + JSON `ok` 이관이 **별도 소비 PR**.
6. **onedns `:80` 이관은 명시 단계.** 이 Mac에서 Caddy를 80에 올리려면 `k3d.yaml`의 `80:80`/`443:443`을 옮기거나 Caddy가 `http_port: 8080`을 쓴다. `addressing.proxy: project`만으로는 부족하다.
7. **롤백.** Caddy만 내리려면 `docker compose -f infra/docker-compose.yml --profile proxy stop proxy` (문서화만, CLI `down` 없음).
8. **스킬.** `skill install`은 가역. 프로젝트 절대 symlink는 gitignore.

---

## Key Decisions

1. **이 레포는 엔진 + 주소 층 + 오버레이 라우팅 제어면을 소유하고, 앱 워크로드 배치는 소유하지 않는다.** 프로젝트 무관한 통증(이름, 폴스루 표, writer 발견, 스킬 로드)은 여기로 모은다. compose/k8s/이미지 빌드를 가져오면 두 번째 프로젝트가 갈라진다.
2. **프록시는 Caddy `caddy:2.8.4` compose profile `proxy`다.** 호스트 publish만 `127.0.0.1:{http_port}`. 컨테이너 안 Caddy는 기본 listen (eth0). Caddyfile에 `bind 127.0.0.1`을 넣지 않는다. LAN 테스트는 compose `ports:`/`docker port`.
3. **기본 TLD는 `localhost`, 기본 스킴은 `{service}.{project}.{tld}`.** `{project}`는 DNS-safe `project.host`(slug의 `_`→`-`).
4. **오버레이는 능력 사다리다.** 생략/`none`/명령 부재면 동사 거절. 제네릭 워크로드 헬퍼는 1차에 만들지 않는다. 성공 기준은 `addressing.proxy`로 갈라진다. `--apply` stderr 휴리스틱 없음.
5. **폴스루는 살아 있는 env의 안 붙인 서비스에만 적용한다.** destroy된 env는 404.
6. **`writers: 1`은 앱 baseline advisory 락 파일이다.** rename+pid. 엔진 setup과 overlay attach는 락 밖. CLI는 1차에 `up`을 막지 않는다. 오케스트레이션·리스 큐·`flock(1)`은 없다.
7. **프로파일 불변식은 `parseProfile`이 강제한다.** 최상위 화이트리스트, `qa:` 거절, `forbid_direct_db_writes` 생략=true, overlay 생략=L2 off. 예시는 `npm test` 픽스처.
8. **`addressing.proxy` 생략 = `none`.** 리스너는 명시 `machine`. 이 머신 k3d 예시가 setup만으로 :80을 잃지 않는다.
9. **호스트 `:80` 소유자는 머신에 하나.** `proxy: project`는 Caddy bind를 풀어 주지 않는다. `proxy up`은 `dev-proxy` self이면 멱등 성공, **다른 프로세스**면 실패. onedns k3d 이관은 소비 단계.
10. **`writeCaddyfile`이 Caddyfile의 유일한 writer다.** 전 프로젝트 라이브 프로파일 병합, 호스트 충돌 실패, machine 라우트 0개면 스텁 내용. `proxy up`에 두 번째 스텁 writer를 두지 않는다. 컨테이너 Caddy `http_port`는 80 고정, 호스트 매핑만 override.
17. **`renderUrl`/프로브의 `config.http_port`는 `addressing.proxy === "machine"`에만 쓴다.** `project`/`none`/`portless`는 스킴 호스트만 인쇄한다. `project` 프로브는 호스트 `:80` (있을 때만). Caddy가 8080으로 양보해도 k3d URL에 `:8080`을 붙이지 않는다.
11. **스킬은 symlink만 설치한다.** 프로젝트 `.agents` 절대 링크는 머신 로컬·gitignore. 도구 어댑터는 상대. `~/.grok/skills`는 미검증이라 있을 때만.
12. **`de-novo-skills down`은 계속 없다.**
13. **성공은 분수다.** 프로브는 `127.0.0.1`+`Host`. JSON `ok: false`는 실패.
14. **사실당 집 하나.**
15. **확인 도구는 계속 프로젝트 몫이다.**
16. **사용자에게 보이는 주소에서 포트를 없애는 것과 호스트 bind를 없애는 것은 다르다.** 후자는 `docker:` 네트워크 조인 또는 k3d ClusterIP 계약이다.

---

## Open Questions

구현을 막지 않기 위해 권장 기본을 같이 적는다. 번복 비용이 큰 것은 머신 전역 TLD와 :80 소유권이다.

### Q1. 머신 기본 TLD

- **옵션:** (a) `localhost` (b) 소유 실도메인 (c) dnsmasq 커스텀
- **권장:** (a) `localhost`. DNS 0, RFC 6761, 개인 Mac.
- **번복:** `config.yml`. CORS·OAuth에 박힌 호스트는 프로젝트가 따라가야 한다.
- **입력 필요:** 팀이 `*.local.fulgo.co.kr`을 전 프로젝트 기본으로 쓸지.

### Q2. 이 레포가 프록시 바이너리를 제공하는가

- **옵션:** (a) Caddy 이미지 (채택) (b) 문서만 (c) 호스트 brew
- **권장:** (a). brew는 Alternatives A3에서 거부.
- **닫힌 부분:** :80은 머신 전역. `proxy up`은 `dev-proxy` self이면 멱등, **다른** 점유면 실패 + k3d 9080 / `http_port: 8080` 처방. 기본 포트를 조용히 8080으로 바꾸지 않는다. Caddy가 8080을 써도 `proxy: project` URL에는 그 포트를 붙이지 않는다.
- **입력 필요:** 이 Mac에서 Caddy를 쓸 때 onedns k3d를 9080으로 옮길지, Caddy가 8080을 쓸지 — **소비 프로젝트 결정**. 설계는 둘 다 지원.

### Q3. 오버레이 워크로드를 이 레포가 기동하는가

- **옵션:** (a) 계약만 + 라우팅 표 (채택) (b) 제네릭 compose 헬퍼 1차 (c) k3d 컨트롤러
- **권장:** (a). 픽스처 스텁으로 L2를 이 레포에서 검증. onedns JSON 이관은 소비 PR.
- **입력 필요:** overlay가 필요한 첫 비-k3d 프로젝트가 언제인가.

### Q4. HTTPS 기본

- **옵션:** (a) HTTP only (권장) (b) Caddy `tls internal` (`proxy up --https`) (c) mkcert
- **권장:** (a).
- **입력 필요:** 로컬 OAuth가 첫 날부터 필수인 프로젝트가 기본 사용자인지.

### Q5. `{project}`를 스킴에 항상 넣을 것인가

- **옵션:** (a) 머신 기본 스킴에 포함 (채택) (b) 프로젝트 2개째부터 (c) 항상 생략
- **권장:** (a). `{project}` = `project.host`.
- **입력 필요:** 없음.

### Q6. IPv6 (`::1`) publish — 프로브는 닫음

- **v1 결정:** CLI 프로브·DNS 검사는 IPv4만 (`127.0.0.1` + `Host`, `dns.lookup family:4`). 성공 판정이 AAAA-first로 빨개지지 않는다.
- **남은 측정 (후속):** OrbStack/Docker Desktop에서 `::1:{http_port}` publish가 되는지. 브라우저 경고는 doctor가 유지.
- **입력 필요:** 없음. 듀얼 스택은 1차 PR이 아님.

### Q7. `de-novo-skills setup`이 proxy를 같이 띄울 것인가

- **옵션:** (a) 띄우지 않고 안내 (채택) (b) `proxy: machine`이면 같이 up (c) 별도 `ensure`
- **권장:** (a). 엔진 수명과 :80 소유를 섞지 않는다.

---

## Risks

| 위험 | 심각도 | 완화 |
| --- | --- | --- |
| Caddy와 k3d가 :80을 쟁탈 | 높음 | 생략 `proxy: none`. `proxy up`은 self면 멱등, **other**면 실패 + 처방. `proxy: project`는 bind를 안 풂 — 문서에 명시 |
| `proxy up`이 자기 Caddy를 점유로 거절 | 높음 (수정됨) | `whoOwns`가 `dev-proxy` 매핑이면 self. `compose up -d --wait` |
| `http_port: 8080`이 k3d URL에 붙음 | 높음 (수정됨) | `renderUrl`/프로브는 `proxy === "machine"`일 때만 Caddy 포트. `project`는 `:80` 또는 생략 |
| 컨테이너 `bind 127.0.0.1`로 트래픽 미도달 | 높음 (수정됨) | Caddyfile에 bind 없음. health는 admin API |
| `*.localhost`를 Node/구형 도구가 해석 못 함 | 중간 | doctor DNS `family:4`. `/etc/hosts` 자동 기록은 1차 없음 |
| 브라우저 AAAA-first 실패 | 중간 | CLI는 v4. doctor 경고. 듀얼 스택은 후속 |
| 프로젝트 overlay 명령이 JSON을 안 냄 | 중간 | `ok:true` 없으면 실패. 스텁 픽스처. onedns는 강제 이관 없음 |
| 계획 경로가 워크로드를 변경 | 높음 (수정됨) | stderr 재시도 삭제. `plan_first: false`면 `--apply` 없이 호출 안 함 |
| setup이 다른 프로젝트 Caddy 라우트를 지움 | 높음 (수정됨) | `writeCaddyfile` 전 프로젝트 병합 |
| 프로파일 검증 강화가 기존 yml을 깨뜨림 | 중간 | 생략은 통과. 화이트리스트는 스키마 키만. 엔진 전용 yml은 setup 유지 |
| Caddyfile과 클러스터 drift | 중간 | overlay status drift 카운트 |
| `host.docker.internal` Linux CI | 낮음 | `extra_hosts: host-gateway`. 대상은 Mac. CI는 순수 함수 |
| 스킬 절대 symlink가 커밋됨 | 중간 | gitignore + 설치 출력이 "커밋하지 마라" |
| `~/.grok/skills`가 실제 로드 경로가 아님 | 낮음 | 있을 때만 설치. status에 미검증 |
| 락 advisory라 에이전트가 무시 | 중간 | 스킬 절차 + 표시. 강제 `up` 차단은 2차 |
| overlay `docker:` 이름이 resolve 안 됨 | 중간 | 계약에 `dev-infra` external 조인 필수 |

---

## References

- 이 레포: `infra/bin/cli.mjs`, `infra/bin/setup.mjs`, `infra/docker-compose.yml`, `infra/README.md`, `skills/grove/SKILL.md`, `references/runtime-profile.md`, `examples/*.yml`, 루트 `README.md`, `infra/registry.local.md` (fulgo 이관 메모)
- 선행 패턴 (가져오지 않음): `onedns-microservice/tools/dev-overlay.mjs` (`buildHostRoutes` 폴스루, `--apply` plan-first, JSON 없음), `configs/local-k8s/k3d.yaml` (`80:80`/`443:443`), `docs/design/local-development-overlay.md`, `.agents/skills/onedns-start-local-runtime/SKILL.md`, `.claude/skills/*` **상대** symlink
- RFC 6761 (`.localhost` 특수 TLD)
- Caddy 2 reverse_proxy / admin API / `tls internal` — **사이트 `bind`는 쓰지 않음**
- Gateway API HTTPRoute — 프로젝트 k3d 백엔드. 이 레포는 외부 Host 매칭만 일반화. 메시 내부 `X-Dev-Env`는 프로젝트 몫

---

## PR Plan

각 PR은 독립 리뷰·머지 가능. 앞 PR이 머지되어야 하는 의존만 적는다. 구현은 기존 `node --test infra/bin/` + 한국어 주석 규약을 따른다.

### PR 1 — 프로파일 검증을 엔진 너머로

- **제목:** `de-novo-skills validate`: runtime-profile 불변식과 예시 YAML 기계 검증
- **영향 파일:** `infra/lib/profile.mjs` (신규), `infra/bin/setup.mjs` (`readProfile`이 parseProfile 사용), `infra/bin/cli.mjs` (`validate` 명령), `infra/bin/profile.test.mjs` (신규), `infra/bin/setup.test.mjs` (회귀), `skills/grove/examples/*.yml` (통과 픽스처; 멀티서비스에 `addressing.proxy: project` 추가)
- **의존:** 없음
- **내용:** 최상위 화이트리스트 `version | project | addressing | runtime | services | overlay | data` (`qa` 거절). `single_stack`/`writers`/`forbid_direct_db_writes` 생략=true. overlay 생략=L2 off. `commands.overlay` + overlay 생략/`none` 거절. `project.host` DNS 규칙. `addressing.proxy` 생략=`none`. `de-novo-skills validate [루트]`. 기존 setup 테스트 불변.

### PR 2 — 이름 난 URL 렌더링

- **제목:** `de-novo-skills urls`: addressing.scheme으로 호스트네임을 그린다
- **영향 파일:** `infra/lib/addressing.mjs` (신규), `infra/bin/cli.mjs`, `infra/bin/addressing.test.mjs` (신규), `skills/grove/references/runtime-profile.md` (`addressing.proxy` 생략=none, `project.host`)
- **의존:** PR 1
- **내용:** 스킴 치환, `{project}`=`project.host`. `renderUrl`은 `addressing.proxy === "machine"`이고 호스트 포트가 80/443이 아닐 때만 `:port`. `project`/`none`/`portless`는 스킴 호스트만. `--probe`는 machine이면 `127.0.0.1:{http_port}`+`Host`, 그 외는 포트 없이 인쇄(프로브 생략 또는 아래 PR 5). 리스너 없음. `proxy: none`이 기본.

### PR 3 — 머신 인덱스와 루프백 프록시

- **제목:** `register` + compose profile `proxy`: 전 프로젝트 Caddyfile과 127.0.0.1:{http_port}
- **영향 파일:** `infra/lib/state.mjs`, `infra/lib/projects.mjs`, `infra/lib/proxy.mjs` (`writeCaddyfile` 유일한 writer), `infra/lib/lockfile.mjs` (rename 헬퍼, writer PR이 재사용), `infra/bin/setup.mjs` (register 호출 + 떠 있는 프록시 reload), `infra/docker-compose.yml` (`caddy:2.8.4`, **ports 없음**, admin healthcheck), `infra/bin/cli.mjs` (`register`, `proxy up\|status\|reload`, `proxy up --https`), `infra/bin/proxy.test.mjs`, `infra/bin/projects.test.mjs`, `infra/README.md` (프록시 절, :80 불변식)
- **의존:** PR 2
- **내용:** `~/.dev-infra/` 레이아웃. `register`는 `infra: project`도 허용. 라이브 프로파일 선호. `writeCaddyfile`이 Caddyfile의 **유일한** writer — 병합·호스트 충돌·machine 0개면 스텁 내용·디렉터리면 거절. `proxy up`은 스텁을 따로 쓰지 않는다. Caddyfile 글로벌 `http_port`는 80 고정. Caddyfile에 `bind` 없음. `127.0.0.1`→`host.docker.internal`. `proxy up` = `whoOwns`(`self`/`free` 계속, `other` 실패+처방) → `writeCaddyfile` → override(`127.0.0.1:{http_port}:80`) → `compose up -d --wait`. 이미 `dev-proxy`가 잡고 있으면 멱등 `프록시 1/1`. 443은 `--https`일 때만. health는 `http://127.0.0.1:2019/config/`. reload는 `docker exec … caddy reload --config /etc/caddy/Caddyfile`. setup은 proxy를 자동 up 하지 않음. `down` 없음. `proxy hosts` 없음.

### PR 4 — writer 락

- **제목:** `de-novo-skills writer`: 프로젝트당 baseline 쓰기 소유자 하나 (advisory)
- **영향 파일:** `infra/lib/writer.mjs`, `infra/bin/cli.mjs`, `infra/bin/writer.test.mjs` (`lockfile.mjs`는 PR 3)
- **의존:** PR 1, PR 3 (`state.mjs`, `lockfile.mjs`)
- **내용:** `~/.dev-infra/locks/{slug}.lock`, acquire/release/status, 죽은 pid 탈취, rename+pid. `agent`/`worktree` 소스 고정. 엔진 setup은 락을 요구하지 않음. `commands.up` 미차단. 스킬 세 줄은 PR 5.

### PR 5 — 오버레이 라우팅 제어면

2026-09-04 구현 범위: 프로젝트 명령 dispatch, JSON 영수증, 원자적 lease
registry, `status`/`touch`/`prune`까지 구현했다. Caddy·proxy route 생성과
자동 복구 controller는 여전히 설계이며 구현됐다고 세지 않는다.

- **제목:** `de-novo-skills overlay`: 레지스트리·폴스루·dispatch (`proxy` 모드별 성공)
- **영향 파일:** `infra/lib/overlay.mjs`, `infra/lib/proxy.mjs` (fallthrough 병합은 기존 writer), `infra/bin/cli.mjs`, `infra/bin/overlay-stub.mjs` (신규 픽스처), `infra/bin/overlay.test.mjs`, `skills/grove/references/overlay-contract.md` (신규), `skills/grove/SKILL.md` (**세 줄**: writer, urls, `de-novo-skills overlay`만 — 프로젝트 명령 직접 호출 금지)
- **의존:** PR 3, PR 1
- **내용:** 능력 게이트 (생략/`none`/명령 없음/명령만 있음). env DNS `{0,61}`. full SHA. JSON `ok:true` 필수, `ok:false` 실패. `upstream`은 `proxy: machine` attach만 필수. `project`/`none`/`portless`는 Caddy 생략. 프로브: machine은 `127.0.0.1:{config.http_port}`+Host, project는 호스트 `:80`이 있을 때만(Caddy 포트 아님), none/portless는 생략. plan-first, stderr 휴리스틱 없음, `plan_first: false`면 `--apply` 없이 미호출. 동사 뒤 플래그 통과. cwd=프로젝트 루트, timeout 120s. `docker:` 업스트림은 `dev-infra` external 조인 계약. 스텁으로 레지스트리·폴스루 테스트. 워크로드 기동 코드 없음.

### PR 6 — 스킬 로드 경로 symlink

- **제목:** `de-novo-skills skill install`: 정본을 에이전트 로드 경로에 복사하지 않고 심는다
- **영향 파일:** `infra/lib/skill-install.mjs`, `infra/bin/cli.mjs`, `infra/bin/skill-install.test.mjs`, 루트 `README.md` (온보딩 + **커밋하지 마라**)
- **의존:** 없음 (병렬 가능). CLI help 충돌을 피하려면 다른 CLI PR 이후
- **내용:** 홈 절대 symlink. 프로젝트 `.agents` 절대+gitignore. `.claude`/`.grok` 상대. `.grok` 없으면 생성하지 않음. 실파일 본문 거절. `skill status` realpath. 스킬 본문은 PR 5가 이미 세 줄을 넣었으면 이 PR에서 다시 안 고침.

### PR 7 — doctor와 문서 정렬

- **제목:** `de-novo-skills doctor` 및 사실의 집 정리
- **영향 파일:** `infra/bin/cli.mjs` (`doctor`, `status` 루트 요약), `infra/lib/doctor.mjs`, `infra/bin/doctor.test.mjs`, `references/runtime-profile.md` (`validate` 한 줄), 루트 `README.md`, `infra/README.md` (`registry.local.md` 사람 메모, 도구 인덱스 `~/.dev-infra/projects/`, :80 불변식)
- **의존:** PR 3, 4, 5, 6
- **내용:** doctor가 엔진·`docker port`의 `0.0.0.0` 금지·:80 **other** 점유(self=`dev-proxy`는 정상)·DNS family4·v4+Host 주소(`machine`만 Caddy 포트, `project`는 :80)·writer advisory·overlay 능력·스킬 로드경로·포트 블록 겹침·Caddyfile-이-파일인지·인덱스 stale을 센다. 스킬 본문은 PR 5에서 이미 절차가 있으면 중복하지 않음. `qa:`/브라우저 문구가 되살아나지 않았는지 확인.

**의도적 후속 (1차 PR 아님):** 제네릭 compose overlay 헬퍼, `::1` publish, `/etc/hosts` 옵트인, 엔진 UI 호스트(`mail.{tld}`), 프로젝트 compose의 호스트 포트 제거 + `dev-infra` 네트워크 조인, onedns JSON stdout 이관, writer의 `up` 강제 차단.
