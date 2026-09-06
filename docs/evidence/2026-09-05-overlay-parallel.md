# 오버레이별 병렬 실행 변경과 검증

서로 다른 오버레이의 생성·반영·삭제까지 프로젝트 전체 잠금이 막던 문제를
수정했다. 같은 오버레이의 변경은 계속 상호 배제한다. 실행과 준비 확인 동안에는
오버레이별 잠금을 유지하며, 공통 레지스트리는 짧은 읽기·병합·쓰기 구간에만
잠근다. 다른 오버레이의 기록을 오래된 스냅샷으로 덮어쓰지 않는다.

미완료 작업을 오버레이별로 기록한다. 한쪽 복구가 필요해도 다른 쪽의 변경,
상태 확인, lease 갱신은 진행된다. 오래된 환경 정리도 대상별로 잠그고, 실패한
대상은 남기면서 다른 대상의 정리를 계속한다. 정리 직전에 lease를 다시 확인한다.

운영 계약과 상태 형식 이행의 정본은
[overlay-contract.md](../../skills/grove/references/overlay-contract.md)다. 기존 어댑터가
프로젝트 전체 직렬 실행을 전제로 공통 파일을 갱신했다면, 병렬 CLI 사용 전에
그 파일의 동시 갱신을 어댑터에서 보호해야 한다. 기존 CLI와 새 레지스트리 형식을
섞어 사용하는 대신 공유 레지스트리의 CLI 사용자를 함께 갱신한다.

## 실행 대상과 결과

기존 소비 프로젝트는 사용하지 않았다. 임시 Git 저장소의 실제 워크트리와
격리된 Node HTTP 프로세스에서 변경된 경로를 실행했다. 공유 엔진·DB·라우팅을
조작하지 않았다. 공유 백엔드에서의 어댑터 동시 실행은 `notMeasured`다.

- [회귀 검사](../../infra/bin/overlay-parallel.test.mjs)는 실제 워크트리에서 두
  생성·반영·삭제 명령이 모두 실행 중인 상태를 만든다. 같은 대상의 경쟁 명령은
  거절되고, 완료 순서가 뒤바뀌어도 상대의 기록과 복구 요청이 보존되는지 확인한다.
- 기존 단일 복구 기록을 읽고 보존해 새 형식으로 쓰는 경로, 복구와 무관한 환경의
  상태·lease 갱신, 정리 중 갱신된 lease의 보존, 실패한 대상 이후의 정리를 실행했다.
- [실제 워크트리 재실행](../evaluation/synthetic/worktree-parallel-results.json)은
  실험 호출부의 대기·재시도를 제거했다. 작업자가 한 번씩 명령을 호출하며, 한쪽
  재배포·삭제 중 다른 쪽 소스·산출물·응답과 기준 앱의 유지 여부를 확인했다.
- [합성 실패 시나리오 재실행](../evaluation/synthetic/parallel-results.json)은
  이전 이미지 잔존, 준비 실패, 실행 중단, 정리 실패를 유지한 채 다른 오버레이가
  진행할 수 있는지 확인했다.

구체적인 후보 식별자, 실행 개수와 검사 결과는
[검증 영수증](2026-09-05-overlay-parallel.json)에 기록한다. 후보는 기록된 기준
커밋 위의 미커밋 변경이며 파일 해시로 구분한다. 커밋·푸시는 수행하지 않았다.

```bash
node --test infra/bin/overlay-parallel.test.mjs
node docs/evaluation/synthetic/worktrees.mjs docs/evaluation/synthetic/worktree-parallel-results.json
node docs/evaluation/synthetic/run.mjs docs/evaluation/synthetic/parallel-results.json
npm test
```

운영 코드를 변경 전으로 되돌린 실행과, 오버레이 잠금·복구 기록 키 검사·잠금
회수 보호를 각각 제거한 실행에서 새 검사가 실패하는 것을 확인했다. 변형한
JavaScript는 모두 구문 검사를 통과했다. 이후 운영 코드를 복원하고 전체 검사를
실행했다. 변형 실행의 결과도 검증 영수증에 보존한다.
